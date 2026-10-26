import { test } from "node:test";
import assert from "node:assert/strict";
import { summaryMarkdown } from "../src/summary.mjs";

test("no actions gives one line with the counts", () => {
  assert.equal(summaryMarkdown({ issues: 3, workers: 1 }, []), "No actions: 3 factory issues, 1 active workers.\n");
});

test("several action types become one row each", () => {
  const md = summaryMarkdown({ issues: 4, workers: 2 }, [
    { type: "dispatch", issue: 5, mode: "followup" },
    { type: "escalate", issue: 6, reason: "bad | worse" },
    { type: "claim", issue: 7 },
    { type: "skip", reason: "FACTORY_ENABLED is false" },
  ]);
  assert.deepEqual(md.trimEnd().split("\n"), [
    "| Issue | Action | Reason or mode |",
    "| --- | --- | --- |",
    "| #5 | dispatch | followup |",
    "| #6 | escalate | bad \\| worse |",
    "| #7 | claim | - |",
    "| - | skip | FACTORY_ENABLED is false |",
  ]);
});
