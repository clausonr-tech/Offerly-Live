#!/usr/bin/env bash
#
# PreToolUse guard: refuse a short list of irreversible shell commands.
#
# WHY A HOOK AND NOT ONLY A DENY RULE
# -----------------------------------
# Written 19 September 2026, before switching Claude Code to bypass-permissions
# mode. `permissions.deny` rules are configured too, but whether they are still
# enforced under bypass could not be confirmed from authoritative documentation,
# and a protection you cannot confirm is not a protection you should rely on.
#
# The settings schema does state plainly that a PreToolUse hook "can block", via
# hookSpecificOutput.permissionDecision = "deny". So this is the layer that is
# documented to work, and the deny rules sit behind it as a second chance.
#
# WHAT THIS IS NOT
# ----------------
# Not a sandbox. It pattern-matches command text, so a determined path around it
# exists - base64, a shell variable, a script file that does the same thing. It
# is aimed at the realistic failure in this project, which is an automated agent
# in a hurry running one wrong command, not an adversary. The recovery net
# (~/offerly-audit) is what covers the rest.
#
# Exit 0 with no output = allow. The JSON below is what blocks.
set -uo pipefail

INPUT="$(cat)"

tool="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")"
[ "$tool" = "Bash" ] || exit 0

cmd="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")"
[ -n "$cmd" ] || exit 0

deny() {
  # Record the attempt.
  #
  # A blocked command leaves NO other trace: denying it here means PostToolUse
  # never runs, so the tool log never sees it. Measured 19 Sep - the first
  # command this guard refused was absent from the trail entirely, which is the
  # wrong way round. An attempt that was stopped is more worth knowing about
  # than the hundred that were fine.
  # OFFERLY_AUDIT_DIR lets the test suite log somewhere disposable. Without it,
  # running the 35 tests appended 35 "blocked" lines to the real trail every
  # time - the log reached 92 blocked entries of which three were real, which
  # makes the record worse than useless: it reads as a machine under constant
  # attack. A test must not be able to forge history.
  local audit_dir="${OFFERLY_AUDIT_DIR:-$HOME/offerly-audit}"
  mkdir -p "$audit_dir" 2>/dev/null
  jq -cn \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg cwd "$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)" \
    --arg session "$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)" \
    --arg cmd "$cmd" \
    --arg reason "$1" \
    '{ts:$ts, ok:false, blocked:true, session:$session, cwd:$cwd, tool:"Bash", target:$cmd, reason:$reason}' \
    >> "$audit_dir/tool-log.jsonl" 2>/dev/null || true

  # permissionDecisionReason is shown to the model, so it says what to do
  # instead rather than only saying no.
  jq -cn --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# Text that is DATA rather than command is removed before matching.
#
# Two kinds, and both bit immediately when this was first switched on:
#
#   git commit -m 'fix rm -rf docs'        - blocked, wrongly
#   git commit -F - <<'EOF' ... force-push - blocked, wrongly
#
# The second one blocked this guard's own commit. Long commit messages here
# routinely quote the commands under discussion, so matching message bodies
# makes committing a coin flip.
#
# The exception both times is a shell that EXECUTES the data: inside
# `bash -c "..."`, `sh -c`, `eval`, `xargs`, or a heredoc piped into a shell,
# the quoted or heredoc text is the command. For those, nothing is stripped.
# ORDER MATTERS HERE. Strip first, then decide.
#
# The first version asked "is this a shell-exec context?" of the WHOLE command,
# body included - so a commit message that merely discussed `bash -c`, `eval`
# and `xargs` convinced the guard that its own heredoc was executable, skipped
# stripping, and then matched `launchctl` in the same prose. It blocked the
# very commit explaining the feature.
#
# Whether a shell executes its data is a fact about the COMMAND, so it has to
# be read from the command text - which is what is left after the data is
# removed.
strip_data() {
  # Heredoc bodies first. The introducer LINE is kept - it holds the real
  # command - and everything up to the closing delimiter is dropped.
  printf '%s\n' "$1" | awk '
    BEGIN { indoc = 0; delim = "" }
    {
      if (indoc) {
        if ($0 ~ "^[[:space:]]*" delim "[[:space:]]*$") { indoc = 0 }
        next
      }
      if (match($0, /<<-?["'"'"']?[A-Za-z_][A-Za-z0-9_]*["'"'"']?/)) {
        d = substr($0, RSTART, RLENGTH)
        sub(/^<<-?/, "", d)
        gsub(/["'"'"']/, "", d)
        delim = d
        indoc = 1
      }
      print
    }' | sed "s/'[^']*'/ QUOTED /g; s/\"[^\"]*\"/ QUOTED /g"
}

command_text="$(strip_data "$cmd")"

# Now ask, of the command text only, whether it hands its data to a shell.
if printf '%s' "$command_text" | grep -Eqi '(^|[^[:alnum:]])(bash|sh|zsh)([[:space:]]+-[a-z]*c)?([[:space:]]*<<)|(^|[^[:alnum:]])(bash|sh|zsh)[[:space:]]+-[a-z]*c([^[:alnum:]]|$)|(^|[^[:alnum:]])(eval|xargs)([^[:alnum:]]|$)'; then
  # It does, so the data is the command and everything is scanned.
  scannable="$cmd"
else
  scannable="$command_text"
fi

# Compound commands are split so a guarded command hidden after && or ; is still
# seen. Crude on purpose - over-splitting costs a false positive, under-
# splitting costs the whole point.
segments="$(printf '%s' "$scannable" | tr ';|&' '\n')"

while IFS= read -r seg; do
  [ -n "${seg// /}" ] || continue
  s="$(printf '%s' "$seg" | tr '[:upper:]' '[:lower:]')"

  # Recursive force delete. The single most common way to lose something that
  # was not in git.
  case "$s" in
    *"rm -rf"*|*"rm -fr"*|*"rm -r -f"*|*"rm -f -r"*)
      deny "Blocked by offerly-guard: recursive force delete. Remove specific paths, or move them aside (mv) so the change is reversible. If this is genuinely needed, the user should run it themselves." ;;
  esac

  # Force-push. The user's own environment notes say main is protected and must
  # never be force-pushed; this covers every branch, since a force-push is
  # unrecoverable for anyone who already pulled.
  #
  # Anchored on the segment starting with `git push`, not merely containing
  # "push" and "--force" somewhere. The loose version matched prose about
  # force-pushing, which is how it blocked its own commit message.
  if printf '%s' "$s" | grep -Eq '^[[:space:]]*(sudo[[:space:]]+)?(/[^[:space:]]*/)?(git|hub)[[:space:]]+push([[:space:]]|$)'; then
    case "$s" in
      *"--force"*|*" -f"|*" -f "*)
        deny "Blocked by offerly-guard: force-push. It rewrites published history. Push normally, or open a new branch." ;;
    esac
  fi

  # git clean -fdx removes ignored files, which here means local-data - the
  # PGlite database, which is not in git and is the one thing snapshots exist
  # for.
  case "$s" in
    *"git clean"*"-fd"*|*"git clean"*"-xd"*|*"git clean"*"-df"*)
      deny "Blocked by offerly-guard: git clean would delete ignored files, and local-data/ (the PGlite database) is ignored. Delete specific files instead." ;;
  esac

  # Paths holding state that exists nowhere else.
  #
  # Matched as "a destructive verb in command position, aimed at this path", or
  # "a redirect INTO this path". The first version of this tested for a bare ">"
  # anywhere in the segment, which matched `2>&1` - so `chmod +x hook.sh &&
  # ./hook.sh 2>&1` was refused as an attempt to overwrite the hook. Redirecting
  # stderr is not an overwrite.
  destructive_to() {
    local path_re="$1"
    printf '%s' "$s" | grep -Eq "^[[:space:]]*(sudo[[:space:]]+)?(rm|mv|truncate|shred|dd)([[:space:]]|$).*${path_re}" && return 0
    printf '%s' "$s" | grep -Eq "[[:space:]](rm|mv|truncate|shred)[[:space:]].*${path_re}" && return 0
    # A redirect whose TARGET is the path: "> local-data/x", ">local-data/x".
    printf '%s' "$s" | grep -Eq ">[[:space:]]*[^[:space:]&]*${path_re}" && return 0
    return 1
  }

  if destructive_to "local-data"; then
    deny "Blocked by offerly-guard: this touches local-data/, which holds the PGlite database and its backups - not in git, and the reason checkpoints exist. Take a checkpoint first, and prefer copying over moving."
  fi
  if destructive_to "offerly-audit"; then
    deny "Blocked by offerly-guard: this would remove or overwrite part of the audit trail or its snapshots, which is the record of what happened. Rotate the log by gzipping it instead (see ~/offerly-audit/README.md)."
  fi

  # Installing or removing the scheduled crawl. The user's standing decision is
  # that it stays uninstalled until the app is on real Postgres, because a
  # scheduled run against single-writer PGlite is how the database was lost.
  case "$s" in
    *"launchctl load"*|*"launchctl unload"*|*"launchctl bootstrap"*|*"launchctl bootout"*)
      deny "Blocked by offerly-guard: installing or removing a launchd job. The scheduled crawl is deliberately uninstalled until the Supabase move - see scripts/com.offerly.crawl-refresh.plist. The user should do this themselves if they have changed their mind." ;;
  esac

  # drizzle-kit push --force answers the column-rename prompt blind, which can
  # drop a column and its data. scripts/schema-drift.ts exists to avoid this.
  case "$s" in
    *"drizzle-kit push"*"--force"*)
      deny "Blocked by offerly-guard: 'drizzle-kit push --force' answers the data-loss prompt blind and can drop a column. Run scripts/schema-drift.ts to see the difference first." ;;
  esac

  # Turning off the guard rails, including this one.
  if destructive_to "\\.claude/hooks"; then
    deny "Blocked by offerly-guard: this would remove or overwrite the guard hooks. That is the user's call to make, not an automated one."
  fi
  case "$s" in
    *"disableallhooks"*)
      deny "Blocked by offerly-guard: this would disable all hooks, including this guard and the audit log. That is the user's call to make, not an automated one." ;;
  esac
done <<< "$segments"

exit 0
