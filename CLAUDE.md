# Rules for workers in this repo

- Node 20, ES modules, no runtime dependencies. Use what Node ships (`fetch`, `node:test`, `node:crypto`).
- `src/decide.mjs` stays pure: no network, no clock, no environment. Everything it needs comes in the snapshot.
  New supervisor behaviour is a rule in `decide` plus a test, and at most a thin call in `github.mjs`.
- Every exported function has a JSDoc block that says what it does and why. No inline comments that
  restate the code.
- Tests use `node:test` and `node:assert/strict`, and live in `test/`. Run `npm test` before every commit.
- One issue per PR. Anything outside the issue goes under "Suggested follow-ups" in the PR description.
- Never edit `.github/workflows/` unless the issue asks for it.
