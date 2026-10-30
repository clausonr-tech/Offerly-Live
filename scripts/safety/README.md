# Safety rails for running this repo under bypass permissions

Set up 19 September 2026, before switching Claude Code to
bypass-permissions mode.

**These files are a versioned COPY. The live ones are at
`~/.claude/hooks/`** — that is where Claude Code reads them from, and a
`~/.claude` path is machine config rather than project code. They are kept
here because otherwise the entire safety layer lives in one unversioned
directory: lose it, and nothing records that it ever existed or what it
blocked.

Re-install after a machine change:

```bash
cp scripts/safety/offerly-guard.sh scripts/safety/offerly-guard-test.sh ~/.claude/hooks/
chmod 755 ~/.claude/hooks/offerly-guard.sh ~/.claude/hooks/offerly-guard-test.sh
~/.claude/hooks/offerly-guard-test.sh          # expect 33 passed, 0 failed
```

Then register the hook in `~/.claude/settings.json` under
`hooks.PreToolUse` with `"matcher": "Bash"`, pointing at
`~/.claude/hooks/offerly-guard.sh`. Merge with whatever is already there —
this machine also runs gstack hooks, and replacing the array would silently
remove them.

## What each piece does

| | |
|---|---|
`offerly-guard.sh` | `PreToolUse` hook. Refuses a short list of irreversible shell commands. Logs every refusal to the audit trail, because a blocked command otherwise leaves no trace at all — `PostToolUse` never runs for it. |
`offerly-guard-test.sh` | 33 cases. Run it after any edit to the guard. |
`../checkpoint.sh` | Snapshots the PGlite database plus the commit the code was on. The part git does not cover. |
`~/offerly-audit/README.md` | The rollback instructions and the log queries. |

## Why a hook and not just a deny list

`permissions.deny` rules are configured too, but **whether they still fire
under bypass-permissions mode could not be confirmed** from authoritative
documentation. A protection you cannot confirm is not one to build on. The
settings schema does state that a `PreToolUse` hook can block, via
`permissionDecision: "deny"` — so the hook is the layer doing the work and the
deny rules are a second chance.

It is **not a sandbox**: it matches command text, so a determined way around it
exists. It is aimed at the realistic failure here — one wrong command run
quickly — not at an adversary.

## Three things it got wrong, kept here so they are not reintroduced

Each was found by running it, not by reading it.

1. **Quoted text was matched**, so `git commit -m 'fix rm -rf docs'` was
   refused. Commit messages in this repo routinely quote the commands under
   discussion.
2. **Heredoc bodies were matched**, which blocked the guard's own commit.
   Heredocs are how commit messages get written here. Both are now stripped
   before matching — *except* inside `bash -c`, `sh -c`, `eval`, `xargs`, or a
   heredoc piped into a shell, where the data really is the command.
3. **A bare `>` anywhere in the command** counted as overwriting a protected
   path, so `chmod +x hook.sh && ./hook.sh 2>&1` was refused. Redirects are now
   matched only when the target is the protected path.

The pattern in all three: the guard cannot tell command from data by looking
for words. It has to know which position the words are in.
