import { test } from "node:test";
import assert from "node:assert/strict";
import { isFeedback } from "../src/github.mjs";

const bots = new Set(["coderabbitai[bot]"]);
const human = (association) => ({ user: { login: "dev", type: "User" }, author_association: association, body: "please rename" });
const bot = (login) => ({ user: { login, type: "Bot" }, author_association: "NONE", body: "Consider a guard here." });

test("people with write access are feedback anywhere on the PR", () => {
  for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) assert.equal(isFeedback(human(a), "issue", bots), true);
});

test("comments from anyone else never reach a worker", () => {
  for (const a of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"]) assert.equal(isFeedback(human(a), "inline", bots), false);
});

test("an allowlisted review bot counts only for inline comments", () => {
  assert.equal(isFeedback(bot("coderabbitai[bot]"), "inline", bots), true);
  assert.equal(isFeedback(bot("coderabbitai[bot]"), "issue", bots), false);
  assert.equal(isFeedback(bot("coderabbitai[bot]"), "review", bots), false);
});

test("other bots, including the factory's own, are ignored", () => {
  assert.equal(isFeedback(bot("github-actions[bot]"), "inline", bots), false);
});

test("empty comments are ignored", () => {
  assert.equal(isFeedback({ ...human("OWNER"), body: "  " }, "issue", bots), false);
});

test("commands to a review bot are not feedback", () => {
  assert.equal(isFeedback({ ...human("OWNER"), body: "@coderabbitai review" }, "issue", bots), false);
});
