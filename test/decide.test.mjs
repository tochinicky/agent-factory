import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, LABELS, branchFor } from "../src/decide.mjs";

const MIN = 60000;
const NOW = 1_000 * MIN;

/** Builds a snapshot with sensible empty defaults. */
function snap(over = {}) {
  return { now: NOW, issues: [], prs: {}, activeRuns: {}, openIssues: new Set(), ...over };
}
const ready = (number, extra = {}) => ({ number, labels: [LABELS.ready], body: "", state: null, ...extra });
const working = (number, state = {}, labels = []) =>
  ({ number, labels: [LABELS.inProgress, ...labels], body: "", state: { attempt: 1, nudges: 0, ...state } });
const openPr = (over = {}) =>
  ({ number: 50, state: "open", merged: false, mergeable: "clean", headSha: "a1", checks: "success", failedChecks: [], feedback: [], ...over });

test("kill switch stops the tick", () => {
  assert.deepEqual(decide(snap({ config: { enabled: false }, issues: [ready(1)] })).map((a) => a.type), ["skip"]);
});

test("claims ready tickets oldest first, up to the slot cap", () => {
  const actions = decide(snap({ config: { maxSlots: 2 }, issues: [ready(9), ready(3), ready(5)] }));
  assert.deepEqual(actions.map((a) => [a.type, a.issue]), [["claim", 3], ["claim", 5]]);
  assert.equal(actions[0].branch, branchFor(3));
});

test("a full board claims nothing", () => {
  const actions = decide(snap({ config: { maxSlots: 1 }, issues: [working(1), ready(2)], activeRuns: { 1: { id: 7, startedAt: NOW } } }));
  assert.deepEqual(actions, []);
});

test("skips tickets blocked by an open issue", () => {
  const actions = decide(snap({ issues: [ready(2, { body: "blocked-by: #1" }), ready(3)], openIssues: new Set([1, 2, 3]) }));
  assert.deepEqual(actions.map((a) => a.issue), [3]);
});

test("never runs two tickets in the same area", () => {
  const issues = [working(1, {}, ["area:api"]), ready(2, { labels: [LABELS.ready, "area:api"] }), ready(3, { labels: [LABELS.ready, "area:ui"] })];
  const actions = decide(snap({ config: { maxSlots: 3 }, issues, activeRuns: { 1: { id: 7, startedAt: NOW } } }));
  assert.deepEqual(actions.map((a) => a.issue), [3]);
});

test("does not dispatch again while a fresh dispatch may still be queued", () => {
  const actions = decide(snap({ issues: [working(1, { dispatchedAt: NOW - 2 * MIN })] }));
  assert.deepEqual(actions, []);
});

test("cancels a worker that outlives its lease", () => {
  const actions = decide(snap({ issues: [working(1)], activeRuns: { 1: { id: 7, startedAt: NOW - 50 * MIN } } }));
  assert.deepEqual(actions.map((a) => [a.type, a.runId]), [["cancel", 7]]);
});

test("retries once when a worker ends without a PR, then escalates", () => {
  const first = decide(snap({ issues: [working(1, { attempt: 1, dispatchedAt: NOW - 30 * MIN })] }));
  assert.deepEqual(first.map((a) => [a.type, a.mode, a.state.attempt]), [["dispatch", "implement", 2]]);
  const second = decide(snap({ issues: [working(1, { attempt: 2, dispatchedAt: NOW - 30 * MIN })] }));
  assert.equal(second[0].type, "escalate");
});

test("a merged PR finishes the ticket and frees its slot", () => {
  const actions = decide(snap({ config: { maxSlots: 1 }, issues: [working(1), ready(2)], prs: { [branchFor(1)]: openPr({ merged: true, state: "closed" }) } }));
  assert.deepEqual(actions.map((a) => [a.type, a.issue]), [["finish", 1], ["claim", 2]]);
});

test("waits while checks are pending", () => {
  const actions = decide(snap({ issues: [working(1)], prs: { [branchFor(1)]: openPr({ checks: "pending" }) } }));
  assert.deepEqual(actions, []);
});

test("a green PR with no feedback is announced once as ready for review", () => {
  const prs = { [branchFor(1)]: openPr() };
  assert.equal(decide(snap({ issues: [working(1)], prs }))[0].type, "ready");
  assert.deepEqual(decide(snap({ issues: [working(1, { readyNotified: true })], prs })), []);
});

test("bundles conflicts, failed checks and new comments into one follow-up", () => {
  const pr = openPr({ mergeable: "dirty", checks: "failure", failedChecks: ["test"], feedback: [{ id: 11, author: "rev", body: "rename x", at: "2026-10-26T10:00:00Z" }] });
  const [a] = decide(snap({ issues: [working(1)], prs: { [branchFor(1)]: pr } }));
  assert.equal(a.type, "dispatch");
  assert.equal(a.mode, "followup");
  assert.match(a.feedback, /conflicts with main/);
  assert.match(a.feedback, /test/);
  assert.match(a.feedback, /rename x/);
  assert.equal(a.state.nudges, 1);
  assert.equal(a.state.feedbackSeenAt, "2026-10-26T10:00:00Z");
});

test("old comments are not sent twice", () => {
  const pr = openPr({ feedback: [{ id: 11, author: "rev", body: "done already", at: "2026-10-26T10:00:00Z" }] });
  const actions = decide(snap({ issues: [working(1, { feedbackSeenAt: "2026-10-26T10:00:00Z", readyNotified: true })], prs: { [branchFor(1)]: pr } }));
  assert.deepEqual(actions, []);
});

test("escalates when a follow-up changed nothing", () => {
  const pr = openPr({ checks: "failure", failedChecks: ["test"] });
  const [first] = decide(snap({ issues: [working(1)], prs: { [branchFor(1)]: pr } }));
  const [second] = decide(snap({ now: NOW + 10 * MIN, issues: [working(1, first.state)], prs: { [branchFor(1)]: pr } }));
  assert.equal(second.type, "escalate");
  assert.match(second.reason, /without changing anything/);
});

test("escalates when the same check fails again after a new push", () => {
  const [first] = decide(snap({ issues: [working(1)], prs: { [branchFor(1)]: openPr({ checks: "failure", failedChecks: ["test"] }) } }));
  const [second] = decide(snap({ now: NOW + 10 * MIN, issues: [working(1, first.state)], prs: { [branchFor(1)]: openPr({ headSha: "b2", checks: "failure", failedChecks: ["test"] }) } }));
  assert.equal(second.type, "escalate");
  assert.match(second.reason, /same checks failed again/);
});

test("escalates at the follow-up cap", () => {
  const pr = openPr({ feedback: [{ id: 12, author: "rev", body: "again", at: "2026-10-26T11:00:00Z" }] });
  const [a] = decide(snap({ issues: [working(1, { nudges: 7 })], prs: { [branchFor(1)]: pr } }));
  assert.equal(a.type, "escalate");
  assert.match(a.reason, /cap of 7/);
});

test("a paused ticket keeps its slot and is left alone", () => {
  const actions = decide(snap({ config: { maxSlots: 1 }, issues: [working(1, {}, [LABELS.pause]), ready(2)] }));
  assert.deepEqual(actions, []);
});

test("starts CI once when a PR has no checks at all", () => {
  const prs = { [branchFor(1)]: openPr({ checks: "missing" }) };
  const [a] = decide(snap({ issues: [working(1)], prs }));
  assert.deepEqual([a.type, a.branch], ["runCi", branchFor(1)]);
  assert.deepEqual(decide(snap({ issues: [working(1, a.state)], prs })), []);
});
