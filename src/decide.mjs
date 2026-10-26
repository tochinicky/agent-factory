/**
 * The supervisor's decision logic. Pure: it takes a snapshot of GitHub and returns the actions
 * to take, so every rule can be tested without a network. It keeps no memory between ticks;
 * anything it needs next time is written back to the issue as state.
 * @module decide
 */
import { createHash } from "node:crypto";

export const LABELS = {
  ready: "factory:ready",
  inProgress: "factory:in-progress",
  needsHuman: "factory:needs-human",
  pause: "factory:pause",
};

export const DEFAULT_CONFIG = {
  enabled: true,
  maxSlots: 2,
  leaseMinutes: 45,
  dispatchGraceMinutes: 5,
  maxAttempts: 2,
  maxNudges: 7,
};

/**
 * Names the branch that claims an issue. Creating it is the claim, so one name per issue.
 * @param {number} issue
 * @returns {string}
 */
export function branchFor(issue) {
  return `factory/issue-${issue}`;
}

/**
 * Reads the `blocked-by: #N` lines from an issue body.
 * @param {string} body
 * @returns {number[]}
 */
export function blockedBy(body = "") {
  return [...body.matchAll(/blocked-by:\s*#(\d+)/gi)].map((m) => Number(m[1]));
}

/**
 * Returns the `area:*` labels that act as locks: two tickets in one area never run together.
 * @param {string[]} labels
 * @returns {string[]}
 */
export function areasOf(labels) {
  return labels.filter((l) => l.startsWith("area:"));
}

/**
 * Hashes what a worker would be asked to fix, so the same request is never sent twice.
 * @param {object} parts
 * @returns {string}
 */
export function feedbackHash(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * Builds the single follow-up message that bundles everything that changed on a PR.
 * @param {{dirty: boolean, failedChecks: string[], comments: {author: string, body: string}[]}} problems
 * @returns {string}
 */
export function followUpMessage({ dirty, failedChecks, comments }) {
  const parts = [];
  if (dirty) parts.push("- The branch conflicts with main. Rebase onto origin/main and resolve the conflicts.");
  if (failedChecks.length) parts.push(`- These checks failed: ${failedChecks.join(", ")}. Run the tests locally and fix the cause.`);
  for (const c of comments) parts.push(`- Review comment from @${c.author}:\n  > ${c.body.replace(/\n/g, "\n  > ")}`);
  return parts.join("\n");
}

/**
 * Decides one tick. Rules, in order, for each issue already in progress:
 * merged PR → finish; CI that never ran → start it; a run older than its lease → cancel; a run still going → wait;
 * nothing to show after the allowed attempts → escalate; open PR with new problems → one bundled
 * follow-up, capped and escalated when the worker makes no progress. Then free slots are filled
 * from the ready queue, oldest first, skipping blocked tickets and busy areas.
 * @param {object} snapshot
 * @param {number} snapshot.now epoch milliseconds
 * @param {object} [snapshot.config]
 * @param {{number: number, labels: string[], body: string, state: object|null}[]} snapshot.issues open issues with a factory label
 * @param {Record<string, object>} snapshot.prs PRs keyed by head branch
 * @param {Record<number, {id: number, startedAt: number}>} snapshot.activeRuns queued or running workers, keyed by issue
 * @param {Set<number>} snapshot.openIssues every open issue number, for blocked-by checks
 * @returns {object[]} actions
 */
export function decide({ now, config: overrides = {}, issues, prs, activeRuns, openIssues }) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  if (!config.enabled) return [{ type: "skip", reason: "FACTORY_ENABLED is false" }];

  const actions = [];
  const minutes = (ms) => ms / 60000;
  let busy = 0;
  const heldAreas = new Set();

  for (const issue of issues.filter((i) => i.labels.includes(LABELS.inProgress))) {
    if (issue.labels.includes(LABELS.pause)) { busy++; areasOf(issue.labels).forEach((a) => heldAreas.add(a)); continue; }
    const n = issue.number;
    const branch = branchFor(n);
    const st = { attempt: 1, nudges: 0, ...(issue.state ?? {}) };
    const pr = prs[branch];
    const run = activeRuns[n];
    const escalate = (reason) => actions.push({ type: "escalate", issue: n, reason, state: { ...st, escalated: reason } });
    const inGrace = st.dispatchedAt && minutes(now - st.dispatchedAt) < config.dispatchGraceMinutes;

    if (pr?.merged) { actions.push({ type: "finish", issue: n }); continue; }

    busy++;
    areasOf(issue.labels).forEach((a) => heldAreas.add(a));

    if (run) {
      if (minutes(now - run.startedAt) > config.leaseMinutes) {
        actions.push({ type: "cancel", issue: n, runId: run.id, reason: `worker ran past its ${config.leaseMinutes}-minute lease` });
      }
      continue;
    }
    if (inGrace) continue;

    if (!pr || pr.state === "closed") {
      if (pr?.state === "closed") { escalate("the PR was closed without merging"); continue; }
      if (st.attempt >= config.maxAttempts) { escalate(`the worker finished ${st.attempt} times without opening a PR`); continue; }
      actions.push({ type: "dispatch", issue: n, branch, mode: "implement", state: { ...st, attempt: st.attempt + 1, dispatchedAt: now } });
      continue;
    }

    if (pr.checks === "missing") {
      if (st.ciRequestedFor !== pr.headSha) {
        actions.push({ type: "runCi", issue: n, branch, state: { ...st, ciRequestedFor: pr.headSha, ciRequestedAt: now } });
      } else if (st.ciRequestedAt && minutes(now - st.ciRequestedAt) > config.leaseMinutes) {
        escalate("CI never reported on the PR");
      }
      continue;
    }
    if (pr.checks === "pending") continue;

    const comments = pr.feedback.filter((c) => !st.feedbackSeenAt || c.at > st.feedbackSeenAt);
    const failedChecks = pr.checks === "failure" ? pr.failedChecks : [];
    const dirty = pr.mergeable === "dirty";

    if (!comments.length && !failedChecks.length && !dirty) {
      if (!st.readyNotified) {
        actions.push({ type: "ready", issue: n, pr: pr.number, state: { ...st, readyNotified: true } });
      }
      continue;
    }

    const hash = feedbackHash({ head: pr.headSha, failedChecks, dirty, comments: comments.map((c) => c.id) });
    const failureSig = failedChecks.length ? failedChecks.join(",") : null;
    if (hash === st.lastHash) { escalate("the worker answered a follow-up without changing anything"); continue; }
    if (failureSig && failureSig === st.lastFailureSig && pr.headSha !== st.lastNudgeHead) {
      escalate(`the same checks failed again after a fix attempt (${failureSig})`);
      continue;
    }
    if (st.nudges >= config.maxNudges) { escalate(`reached the cap of ${config.maxNudges} follow-ups`); continue; }

    actions.push({
      type: "dispatch", issue: n, branch, mode: "followup", pr: pr.number,
      feedback: followUpMessage({ dirty, failedChecks, comments }),
      state: {
        ...st, nudges: st.nudges + 1, lastHash: hash, lastFailureSig: failureSig, lastNudgeHead: pr.headSha,
        feedbackSeenAt: comments.reduce((max, c) => (c.at > max ? c.at : max), st.feedbackSeenAt ?? ""),
        readyNotified: false, dispatchedAt: now,
      },
    });
  }

  const ready = issues
    .filter((i) => i.labels.includes(LABELS.ready) && !i.labels.includes(LABELS.inProgress) && !i.labels.includes(LABELS.pause))
    .sort((a, b) => a.number - b.number);

  for (const issue of ready) {
    if (busy >= config.maxSlots) break;
    if (blockedBy(issue.body).some((b) => openIssues.has(b))) continue;
    const areas = areasOf(issue.labels);
    if (areas.some((a) => heldAreas.has(a))) continue;
    areas.forEach((a) => heldAreas.add(a));
    busy++;
    actions.push({
      type: "claim", issue: issue.number, branch: branchFor(issue.number),
      state: { attempt: 1, nudges: 0, claimedAt: now, dispatchedAt: now },
    });
  }

  return actions;
}
