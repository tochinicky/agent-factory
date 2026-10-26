import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAction, isDryRun, missingEnv, tick } from "../src/supervise.mjs";

const WRITES = ["ensureLabels", "claim", "saveState", "relabel", "comment", "dispatchWorker", "dispatchCi", "cancelRun"];

function fakeClient(snapshot) {
  const calls = [];
  const gh = { snapshot: async () => snapshot };
  for (const m of WRITES) gh[m] = async () => (calls.push(m), true);
  return { gh, calls };
}

const snapshot = {
  issues: [{ number: 7, title: "t", labels: ["factory:ready"], body: "", state: null }],
  prs: {},
  activeRuns: {},
  openIssues: new Set([7]),
};

test("dry-run calls no write method and prints the planned actions", async () => {
  const { gh, calls } = fakeClient(snapshot);
  const lines = [];
  await tick({ gh, config: { enabled: true }, dryRun: true, log: (l) => lines.push(l) });
  assert.deepEqual(calls, []);
  assert.ok(lines.includes("[dry-run] would claim #7 (factory/issue-7)"), lines.join("\n"));
});

test("missingEnv names each unset variable", () => {
  assert.deepEqual(missingEnv({}), ["GITHUB_TOKEN", "GITHUB_REPOSITORY"]);
  assert.deepEqual(missingEnv({ GITHUB_TOKEN: "x", GITHUB_REPOSITORY: "o/r" }), []);
});

test("describeAction omits the state blob", () => {
  const line = describeAction({ type: "claim", issue: 7, branch: "factory/issue-7", state: { attempt: 1 } });
  assert.equal(line, "would claim #7 (factory/issue-7)");
});

test("a normal tick does write", async () => {
  const { gh, calls } = fakeClient(snapshot);
  await tick({ gh, config: { enabled: true }, log: () => {} });
  assert.ok(calls.includes("ensureLabels"));
  assert.ok(calls.includes("claim"));
});

test("isDryRun reads the flag and the environment variable", () => {
  assert.equal(isDryRun(["--dry-run"], {}), true);
  assert.equal(isDryRun([], { FACTORY_DRY_RUN: "true" }), true);
  assert.equal(isDryRun([], {}), false);
});
