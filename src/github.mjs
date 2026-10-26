/**
 * Thin GitHub REST adapter: reads the snapshot the supervisor decides on, and carries out
 * the actions it returns. No decisions are made here.
 * @module github
 */
import { LABELS } from "./decide.mjs";

const STATE_MARKER = "factory-state:";
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const CI_CHECK = "test";
const REVIEW_BOTS = new Set((process.env.FACTORY_REVIEW_BOTS ?? "coderabbitai[bot]").split(",").map((b) => b.trim()).filter(Boolean));

/**
 * Decides whether a PR comment may reach a worker's prompt. People need write access, because on a
 * public repo anyone can comment and a comment is a way to give the agent instructions. Review
 * bots on the allowlist count only for inline comments on a line of the diff: their summaries and
 * review bodies are long, rarely actionable, and would cost a worker run each time they change.
 * @param {{user?: {login: string, type: string}, author_association?: string, body?: string}} comment
 * @param {"issue"|"inline"|"review"} kind where the comment was posted
 * @param {Set<string>} [reviewBots]
 * @returns {boolean}
 */
export function isFeedback(comment, kind, reviewBots = REVIEW_BOTS) {
  if (!comment.body?.trim() || !comment.user) return false;
  if (comment.user.type === "Bot") return kind === "inline" && reviewBots.has(comment.user.login);
  return TRUSTED.has(comment.author_association);
}

/**
 * Creates a client bound to one repository.
 * @param {{token: string, repo: string, api?: string}} options
 */
export function github({ token, repo, api = "https://api.github.com" }) {
  /**
   * Calls the REST API and returns parsed JSON, or null for an empty body.
   * @param {string} method
   * @param {string} path relative to /repos/{repo}, or absolute when it starts with https
   * @param {object} [body]
   * @param {{allow?: number[]}} [opts] status codes to return instead of throwing
   */
  async function call(method, path, body, { allow = [] } = {}) {
    const url = path.startsWith("https") ? path : `${api}/repos/${repo}${path}`;
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !allow.includes(res.status)) throw new Error(`${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  }
  const get = async (path) => (await call("GET", path)).data;

  /**
   * Finds the comment that holds an issue's factory state.
   * @param {number} issue
   * @returns {Promise<{id: number, state: object}|null>}
   */
  async function stateComment(issue) {
    const comments = await get(`/issues/${issue}/comments?per_page=100`);
    const c = comments.reverse().find((x) => x.body?.includes(`<!-- ${STATE_MARKER}`));
    if (!c) return null;
    const json = c.body.match(new RegExp(`<!-- ${STATE_MARKER}(.*?) -->`, "s"))?.[1];
    return { id: c.id, state: json ? JSON.parse(json) : null };
  }

  /**
   * Summarises a PR's checks: missing (none at all), pending, success or failure.
   * @param {string} sha
   */
  async function checksFor(sha) {
    const runs = (await get(`/commits/${sha}/check-runs?per_page=100`)).check_runs.filter((r) => r.name === CI_CHECK);
    if (!runs.length) return { checks: "missing", failedChecks: [] };
    if (runs.some((r) => r.status !== "completed")) return { checks: "pending", failedChecks: [] };
    const failed = runs.filter((r) => !["success", "skipped", "neutral"].includes(r.conclusion)).map((r) => r.name);
    return { checks: failed.length ? "failure" : "success", failedChecks: [...new Set(failed)] };
  }

  /**
   * Collects the review feedback on a PR that may reach a worker; see {@link isFeedback}.
   * @param {number} pr
   */
  async function feedbackFor(pr) {
    const [issueComments, reviewComments, reviews] = await Promise.all([
      get(`/issues/${pr}/comments?per_page=100`),
      get(`/pulls/${pr}/comments?per_page=100`),
      get(`/pulls/${pr}/reviews?per_page=100`),
    ]);
    const where = (x) => (x.path ? ` (on ${x.path}${x.line ? `:${x.line}` : ""})` : "");
    return [
      ...issueComments.filter((x) => isFeedback(x, "issue")).map((x) => ({ id: `c${x.id}`, author: x.user.login, body: x.body, at: x.created_at })),
      ...reviewComments.filter((x) => isFeedback(x, "inline")).map((x) => ({ id: `r${x.id}`, author: x.user.login, body: `${x.body}${where(x)}`, at: x.created_at })),
      ...reviews.filter((x) => isFeedback(x, "review")).map((x) => ({ id: `v${x.id}`, author: x.user.login, body: x.body, at: x.submitted_at })),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }

  return {
    /**
     * Reads everything one tick needs.
     * @param {number} now
     */
    async snapshot(now) {
      const all = (await get(`/issues?state=open&per_page=100`)).filter((i) => !i.pull_request);
      const openIssues = new Set(all.map((i) => i.number));
      const issues = await Promise.all(all
        .filter((i) => i.labels.some((l) => l.name.startsWith("factory:")))
        .map(async (i) => {
          const labels = i.labels.map((l) => l.name);
          const sc = labels.includes(LABELS.inProgress) ? await stateComment(i.number) : null;
          return { number: i.number, title: i.title, labels, body: i.body ?? "", state: sc?.state ?? null };
        }));

      const prs = {};
      const pulls = (await get(`/pulls?state=all&per_page=100&sort=updated&direction=desc`)).filter((p) => p.head.ref.startsWith("factory/"));
      for (const p of pulls) {
        if (prs[p.head.ref]) continue;
        const entry = { number: p.number, state: p.state, merged: Boolean(p.merged_at), headSha: p.head.sha, mergeable: "unknown", checks: "pending", failedChecks: [], feedback: [] };
        if (p.state === "open") {
          const full = await get(`/pulls/${p.number}`);
          Object.assign(entry, { mergeable: full.mergeable_state }, await checksFor(p.head.sha), { feedback: await feedbackFor(p.number) });
        }
        prs[p.head.ref] = entry;
      }

      const activeRuns = {};
      for (const status of ["queued", "in_progress"]) {
        const { workflow_runs } = await get(`/actions/workflows/worker.yml/runs?status=${status}&per_page=100`);
        for (const r of workflow_runs) {
          const issue = Number(r.display_title.match(/#(\d+)/)?.[1]);
          if (issue) activeRuns[issue] = { id: r.id, startedAt: Date.parse(r.run_started_at ?? r.created_at) };
        }
      }
      return { now, issues, prs, activeRuns, openIssues };
    },

    /** Creates the factory labels if they are missing. */
    async ensureLabels() {
      const colors = { [LABELS.ready]: "0e8a16", [LABELS.inProgress]: "fbca04", [LABELS.needsHuman]: "d93f0b", [LABELS.pause]: "cccccc" };
      for (const [name, color] of Object.entries(colors)) await call("POST", "/labels", { name, color }, { allow: [422] });
    },

    /**
     * Claims an issue by creating its branch from main. GitHub refuses to create a ref that
     * already exists, so of two claims racing for one issue exactly one wins.
     * @returns {Promise<boolean>} whether this call won the claim
     */
    async claim(branch) {
      const main = await get(`/git/ref/heads/main`);
      const r = await call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: main.object.sha }, { allow: [422] });
      return r.status === 201;
    },

    /** Writes the issue's state into its marker comment, creating the comment the first time. */
    async saveState(issue, state) {
      const body = `Factory state (managed by the supervisor, please leave it).\n<!-- ${STATE_MARKER}${JSON.stringify(state)} -->`;
      const sc = await stateComment(issue);
      if (sc) await call("PATCH", `/issues/comments/${sc.id}`, { body });
      else await call("POST", `/issues/${issue}/comments`, { body });
    },

    /** Replaces one label with another on an issue. */
    async relabel(issue, remove, add) {
      if (remove) await call("DELETE", `/issues/${issue}/labels/${encodeURIComponent(remove)}`, null, { allow: [404] });
      if (add) await call("POST", `/issues/${issue}/labels`, { labels: [add] });
    },

    /** Posts a comment on an issue or PR. */
    async comment(issue, body) {
      await call("POST", `/issues/${issue}/comments`, { body });
    },

    /** Starts a worker run. */
    async dispatchWorker({ issue, mode, feedback = "", pr = "" }) {
      await call("POST", `/actions/workflows/worker.yml/dispatches`, { ref: "main", inputs: { issue: String(issue), mode, feedback, pr: String(pr) } });
    },

    /** Starts CI on a branch; its check runs attach to the branch's head commit, so they show on the PR. */
    async dispatchCi(branch) {
      await call("POST", `/actions/workflows/ci.yml/dispatches`, { ref: branch });
    },

    /** Cancels a workflow run. */
    async cancelRun(id) {
      await call("POST", `/actions/runs/${id}/cancel`, null, { allow: [409] });
    },
  };
}
