/**
 * One supervisor tick: read GitHub, decide, act. Run on a schedule; it is safe to run twice,
 * because every action is keyed by issue and branch and the state lives on the issue.
 * @module supervise
 */
import { decide, LABELS } from "./decide.mjs";
import { pathToFileURL } from "node:url";
import { github } from "./github.mjs";
import { summaryMarkdown } from "./summary.mjs";
import { appendFileSync } from "node:fs";

const env = process.env;
const repoUrl = `https://github.com/${env.GITHUB_REPOSITORY}`;

/**
 * Sends a phone notification through ntfy when a topic is configured. A failed send never
 * fails the tick.
 * @param {string} title
 * @param {string} message
 * @param {string} click
 */
async function notify(title, message, click) {
  if (!env.NTFY_TOPIC) return;
  try {
    await fetch(env.NTFY_SERVER ?? "https://ntfy.sh/", {
      method: "POST",
      body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message, click, tags: ["factory"] }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn(`ntfy failed: ${e.message}`);
  }
}

/**
 * Carries out one action from the decision step.
 * @param {object} a
 * @param {ReturnType<typeof github>} gh
 */
async function apply(a, gh) {
  switch (a.type) {
    case "skip":
      return console.log(`skip: ${a.reason}`);
    case "claim":
      if (!(await gh.claim(a.branch))) return console.log(`#${a.issue}: ${a.branch} already exists, someone else claimed it`);
      await gh.relabel(a.issue, LABELS.ready, LABELS.inProgress);
      await gh.saveState(a.issue, a.state);
      await gh.dispatchWorker({ issue: a.issue, mode: "implement" });
      return console.log(`#${a.issue}: claimed and dispatched`);
    case "dispatch":
      await gh.saveState(a.issue, a.state);
      await gh.dispatchWorker({ issue: a.issue, mode: a.mode, feedback: a.feedback, pr: a.pr });
      return console.log(`#${a.issue}: dispatched ${a.mode}`);
    case "runCi":
      await gh.saveState(a.issue, a.state);
      await gh.dispatchCi(a.branch);
      return console.log(`#${a.issue}: started CI on ${a.branch}`);
    case "cancel":
      await gh.cancelRun(a.runId);
      await gh.comment(a.issue, `Cancelled worker run ${a.runId}: ${a.reason}.`);
      return console.log(`#${a.issue}: cancelled run ${a.runId}`);
    case "escalate":
      await gh.saveState(a.issue, a.state);
      await gh.relabel(a.issue, LABELS.inProgress, LABELS.needsHuman);
      await gh.comment(a.issue, `Stopped and handed back: ${a.reason}. Fix or reset the state, then label it \`${LABELS.inProgress}\` again.`);
      await notify(`Factory needs you: #${a.issue}`, a.reason, `${repoUrl}/issues/${a.issue}`);
      return console.log(`#${a.issue}: escalated (${a.reason})`);
    case "ready":
      await gh.saveState(a.issue, a.state);
      await gh.comment(a.issue, `PR #${a.pr} is green and ready for review.`);
      await notify(`Ready for review: PR #${a.pr}`, `Issue #${a.issue}`, `${repoUrl}/pull/${a.pr}`);
      return console.log(`#${a.issue}: PR #${a.pr} ready for review`);
    case "finish":
      await gh.relabel(a.issue, LABELS.inProgress, null);
      return console.log(`#${a.issue}: merged, slot freed`);
    default:
      throw new Error(`unknown action ${a.type}`);
  }
}

/**
 * Tells whether this run should only report what it would do. Dry-run lets an operator preview a
 * tick against the real repository without changing it.
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} environ
 * @returns {boolean}
 */
export function isDryRun(argv, environ) {
  return argv.includes("--dry-run") || environ.FACTORY_DRY_RUN === "true";
}

/**
 * Names the required variables that are unset, so the CLI can stop with a clear message instead
 * of failing later with an opaque HTTP error.
 * @param {Record<string, string|undefined>} environ
 * @returns {string[]}
 */
export function missingEnv(environ) {
  return ["GITHUB_TOKEN", "GITHUB_REPOSITORY"].filter((k) => !environ[k]);
}

/**
 * Summarises an action as one short line for the dry-run preview, leaving out the state blob.
 * @param {object} a
 * @returns {string}
 */
export function describeAction(a) {
  const target = a.issue ? ` #${a.issue}` : a.runId ? ` run ${a.runId}` : "";
  const detail = a.branch ?? a.mode ?? a.reason;
  return `would ${a.type}${target}${detail ? ` (${detail})` : ""}`;
}

/**
 * Runs one tick: read the snapshot, decide, then act. In dry-run mode it only prints each action
 * and calls no write method on the client (including ensureLabels and notifications), so the
 * preview is safe to run against the real repository.
 * @param {{gh: ReturnType<typeof github>, config: object, dryRun?: boolean, log?: (line: string) => void}} options
 */
export async function tick({ gh, config, dryRun = false, log = console.log }) {
  if (!dryRun) await gh.ensureLabels();
  const snapshot = await gh.snapshot(Date.now());
  const actions = decide({ ...snapshot, config });
  log(`${dryRun ? "[dry-run] " : ""}${snapshot.issues.length} factory issues, ${Object.keys(snapshot.activeRuns).length} active workers, ${actions.length} actions`);
  for (const a of actions) {
    if (dryRun) {
      log(`[dry-run] ${describeAction(a)}`);
      continue;
    }
    try {
      await apply(a, gh);
    } catch (e) {
      console.error(`#${a.issue ?? "-"} ${a.type} failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const counts = { issues: snapshot.issues.length, workers: Object.keys(snapshot.activeRuns).length };
    appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(counts, actions));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const missing = missingEnv(env);
  if (missing.length) {
    console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
    process.exit(1);
  }
  const config = {
    enabled: env.FACTORY_ENABLED !== "false",
    ...(env.FACTORY_MAX_SLOTS ? { maxSlots: Number(env.FACTORY_MAX_SLOTS) } : {}),
  };
  const gh = github({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY });
  await tick({ gh, config, dryRun: isDryRun(process.argv.slice(2), env) });
}
