# Offerly agent instructions

Read `CLAUDE.md` before changing code; its product rules apply to every agent.

## Security work

- Work only on a dedicated non-default branch in an isolated Git worktree.
- Never read or modify `.env`, `.env.local`, `backups/`, `local-data/`,
  `training-data/`, private keys, OAuth tokens, or production credentials.
- Use sanitized local fixtures. Do not access production services or customer data.
- Keep changes inside the written task scope and add regression tests for fixes.
- Run `npm run lint`, `npm run typecheck`, and `npm test` before reporting success.
- Never commit, push, merge, deploy, rotate credentials, or run a production
  migration unless a human explicitly authorizes that exact action.
- A clean test run is necessary but not sufficient. Review authorization,
  tenant isolation, secret handling, failure behavior, and regression risk.

## Claude/Codex review loop

Claude is the implementer. Codex is the independent reviewer. During a review,
Codex must not edit Claude's work. A task is complete only when deterministic
checks pass and Codex returns an approval with no actionable findings. The loop
is capped at three implementation/review rounds and always stops before commit,
push, merge, migration, or deployment.
