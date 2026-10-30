#!/usr/bin/env bash
#
# Tests for offerly-guard.sh.
#
#   ~/.claude/hooks/offerly-guard-test.sh
#
# Lives in a file rather than an inline command on purpose: the cases below
# contain the exact strings the guard refuses, and inside a shell-exec context
# the guard deliberately stops stripping data - so a test harness written as
# one Bash command blocks itself. That is the guard behaving correctly and the
# test being wrong, which took one confused minute to work out and is worth
# not repeating.
set -uo pipefail

GUARD="$HOME/.claude/hooks/offerly-guard.sh"
pass=0
fail=0

# Log the guard's refusals somewhere disposable. Every deny writes a line, so
# without this each run forged ~13 "blocked" entries in the real audit trail -
# it had reached 92, of which three were real. A test suite must not be able to
# write history.
OFFERLY_AUDIT_DIR="$(mktemp -d)"
export OFFERLY_AUDIT_DIR
trap 'rm -r "$OFFERLY_AUDIT_DIR" 2>/dev/null || true' EXIT

# $1 = expected ("deny" or "allow"), $2 = command
check() {
  local want="$1" cmd="$2" got
  got="$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
    "$(jq -Rn --arg c "$cmd" '$c')" | "$GUARD" \
    | jq -r '.hookSpecificOutput.permissionDecision // empty')"
  got="${got:-allow}"
  local label
  label="$(printf '%s' "$cmd" | head -1 | cut -c1-58)"
  if [ "$got" = "$want" ]; then
    printf '  ok    %-60s %s\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-60s got %s, wanted %s\n' "$label" "$got" "$want"
    fail=$((fail + 1))
  fi
}

echo "must BLOCK - real destructive commands"
check deny 'rm -rf /tmp/x'
check deny 'rm -fr /tmp/x'
check deny 'cd /somewhere && rm -rf build'
check deny 'git push --force origin main'
check deny 'git push -f'
check deny 'git push --force-with-lease'
check deny 'git clean -fdx'
check deny 'mv local-data/pglite-v3 /tmp/elsewhere'
check deny 'rm local-data/pglite-v3/base'
check deny 'launchctl load ~/Library/LaunchAgents/com.offerly.crawl-refresh.plist'
check deny 'launchctl unload ~/Library/LaunchAgents/x.plist'
check deny 'npx drizzle-kit push --force'
check deny 'rm -r ~/offerly-audit/snapshots'

echo
echo "must BLOCK - data that a shell would execute"
# A heredoc piped into a shell, and -c, are executed, so nothing is stripped.
check deny "$(printf 'bash <<%sSH%s\nrm -rf /tmp/inner\nSH\n' "'" "'")"
check deny 'bash -c "rm -rf /tmp/z"'
check deny "eval 'rm -rf /tmp/y'"
check deny 'echo x | xargs rm -rf'

echo
echo "must ALLOW - the same words as data, not as commands"
check allow "git commit -m 'fix rm -rf docs'"
check allow 'git commit -m "note about --force pushes"'
# The case that blocked this guard's own commit.
check allow "$(printf 'git commit -F - <<%sEOF%s\nmentions force-push and rm -rf in prose\nEOF\n' "'" "'")"
check allow "$(printf 'cat <<%sEOF%s > /tmp/doc.md\ndocs about git push --force\nEOF\n' "'" "'")"
# The regression that blocked the guard's own commit: a message that DISCUSSES
# shell-exec made the guard treat its own heredoc as executable, so nothing was
# stripped and a blocked word in the same prose matched. Whether a shell
# executes its data is a fact about the command, not about the data.
check allow "$(printf 'git commit -F - <<%sEOF%s\nstripped except inside bash -c, eval or xargs\nit refuses launchctl load and unload too\nEOF\n' "'" "'")"
check allow "$(printf 'git commit -F - <<%sEOF%s\nmentions eval and xargs and rm -rf together\nEOF\n' "'" "'")"

echo
echo "must ALLOW - ordinary work"
check allow 'git status'
check allow 'git push origin feat/my-branch'
check allow 'git log --oneline -10'
check allow 'npm run test'
check allow 'npx tsc --noEmit'
check allow 'ls local-data'
check allow 'cp -R local-data/pglite-v3 local-data/pglite-v3-backup-now'
check allow 'du -sh local-data'
check allow 'npx drizzle-kit push'
check allow 'rm /tmp/single-file.txt'
check allow 'jq . ~/offerly-audit/tool-log.jsonl'
check allow 'scripts/checkpoint.sh "before change"'

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
