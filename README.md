# agent-factory

Claude Code workers that pick up GitHub issues, open PRs and answer review comments, run by a
small supervisor on GitHub Actions. It all runs on GitHub, so nothing needs a laptop to be on.
A person still decides what gets built and is the only one who merges.

```
 you label an issue          supervisor (cron, every 10 min)              worker (Claude Code)
 factory:ready  ───────────▶ read issues, PRs, runs ──▶ decide ──▶ act ──▶ implement / follow up
                                    ▲                                         │
                                    │        PR, CI checks, your review       │ commits
                                    └─────────────────────────────────────────┘
                                                            you merge ──▶ slot freed
```

## How a ticket moves

1. You label an issue `factory:ready`. Add `area:<name>` to lock an area and `blocked-by: #N` in the body to order work.
2. On its next tick the supervisor claims it if a slot is free: it creates `factory/issue-N`,
   relabels the issue `factory:in-progress` and dispatches a worker.
3. The worker (Claude Code in Actions) implements the issue, runs the tests and commits. A fixed
   script step, outside the model, pushes the branch, opens the PR and starts CI.
4. Each tick the supervisor checks the PR. New review comments, failed checks and merge conflicts are
   bundled into **one** follow-up for the worker. A green PR with nothing pending is announced once.
5. You merge. The issue closes and the slot frees up.

The supervisor makes no model calls. Its rules are plain code in [`src/decide.mjs`](src/decide.mjs),
a pure function from a snapshot of GitHub to a list of actions, covered by tests in [`test/`](test/).
It keeps no memory between ticks; each issue carries its own state in a marker comment.

## Duplicate workers

| Cause | Guard |
|---|---|
| Two supervisor ticks overlap | `concurrency: factory-supervisor` runs one tick at a time |
| Two claims race for one issue | The claim is creating the branch `factory/issue-N`. GitHub refuses a ref that already exists, so exactly one claim wins |
| Two workers on one issue | `concurrency: worker-<issue>` on the worker workflow |
| A dispatch that has not started yet looks like a dead worker | A 5-minute grace window after each dispatch before the supervisor acts again |
| A worker's own comments trigger more work | Only the supervisor dispatches workers, and comments from bots are never feedback |

## Conflicting PRs

- **Area locks**: two tickets with the same `area:*` label never run at the same time.
- **Ordering**: a ticket with `blocked-by: #N` waits until #N is closed.
- **Conflicts that still happen**: when GitHub reports the PR as `dirty`, the follow-up asks the
  worker to rebase on `main` and resolve them.
- Turn on a merge queue, or require branches to be up to date, so two PRs that pass separately are
  also tested together before either lands.

## Stuck agents

| Signal | What the supervisor does |
|---|---|
| Worker run older than its 45-minute lease | Cancels the run (the job itself times out at 40) |
| Worker finished without a PR | Retries once, then escalates |
| A follow-up changed nothing | Escalates |
| The same check fails again after a fix | Escalates instead of looping |
| 7 follow-ups on one PR | Escalates |
| CI never reported | Starts CI once, escalates if it still never reports |

Escalating relabels the issue `factory:needs-human`, comments the reason and, with `NTFY_TOPIC` set,
sends a phone notification. Green PRs send one too.

**Kill switches**: set the repository variable `FACTORY_ENABLED=false` to stop every tick, or label a
single issue `factory:pause`.

## Security

- Only people with write access can label issues, so only they can put work on the queue.
- Review feedback reaches a worker only from `OWNER`, `MEMBER` or `COLLABORATOR` authors. On a public
  repo anyone can comment, and a comment would otherwise be a way to give the agent instructions.
- One review bot is allowed through: CodeRabbit (`FACTORY_REVIEW_BOTS`, default `coderabbitai[bot]`),
  and only its inline comments on lines of the diff. Its summaries are not sent to workers. The
  follow-up cap and the no-progress checks stop a reviewer bot and a worker from answering each other
  forever.
- The worker's tools are an allowlist (edit files, run tests, local git). It cannot push or call the
  GitHub API for writes; the push and the PR come from a fixed script step.
- Workers never merge. `main` is protected and needs a human.

## Setup

1. Add the Claude token: run `claude setup-token`, then
   `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/agent-factory`.
2. Optional: `gh secret set NTFY_TOPIC` for phone notifications, and `gh variable set FACTORY_MAX_SLOTS`
   (default 2).
3. Settings → Actions → General: allow GitHub Actions to create pull requests.
4. Label an issue `factory:ready`, and either wait for the next tick or run
   `gh workflow run supervisor.yml`.

## Run the tests

```
npm test
```
