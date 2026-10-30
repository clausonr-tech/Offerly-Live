#!/bin/bash
# The news pipeline, as launchd runs it. Same shape as scheduled-crawl.sh, for
# the same reasons: a skipped run must be loud, Node must not be pinned to one
# version, and two runs must never overlap.
#
# Usage: scheduled-news.sh [run|desk|scout]
#   run    every 30 minutes: collect, label, group, rank
#   desk   twice a day: the same, then the sector desk's top three per sector
#   scout  weekly: look for new sources and propose them for approval
#
# The AI steps go through the `claude` CLI on the owner's subscription, never
# the API (src/lib/news/claude-cli.ts). When the CLI is signed out the run
# still collects and ranks, exits 2, and the marker says AI-BLOCKED - so a
# signed-out laptop shows up as a line in the marker file, not as a tab that
# quietly stops getting new stories.
set -uo pipefail

# The checkout this script lives in, so the same file runs from a worktree
# before a merge and from the main checkout after one.
REPO="${OFFERLY_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
MODE="${1:-run}"
STATE_DIR="$HOME/offerly-audit"
LOCK_DIR="$STATE_DIR/news.lock"
MARKER="$STATE_DIR/last-news-run.txt"

mkdir -p "$STATE_DIR"
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
mark() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $MODE $*" >> "$MARKER"; }

# A Mac notification when runs keep failing. The marker file records every
# failure, but nobody reads it until the News tab is already stale - on
# 29 September 2026 five runs in a row failed before anyone looked. Two
# failures in a row is the threshold: one is usually a blip (a network drop, a
# sleep mid-run) that the next run absorbs; two means something needs a person.
# Only a notification - nothing leaves the machine.
alert_if_failing() {
  local recent
  recent="$(grep " $MODE " "$MARKER" 2>/dev/null | tail -2 | grep -cE " (FAILED|AI-BLOCKED)" || true)"
  if [ "$recent" -ge 2 ] && command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"The last two $MODE runs failed. See /tmp/offerly-news.log and ~/offerly-audit/last-news-run.txt\" with title \"Offerly news pipeline\" sound name \"Basso\"" >/dev/null 2>&1 || true
  fi
}

# mkdir is atomic - a test-then-create would race with the second process.
#
# The lock records the run's PID. A run killed outright (launchctl kickstart -k
# sends SIGKILL, and no trap survives that) leaves its lock behind; on
# 29 September 2026 that made the next run skip itself, and every run after it
# would have too. So a lock whose process is gone is cleared and taken over.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  HOLDER="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$HOLDER" ] && kill -0 "$HOLDER" 2>/dev/null; then
    log "SKIPPED: another news run is still going (pid $HOLDER, lock at $LOCK_DIR)"
    mark "SKIPPED overlapping-run"
    exit 0
  fi
  log "clearing a stale lock left by a run that no longer exists (pid ${HOLDER:-unknown})"
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "SKIPPED: could not take the lock at $LOCK_DIR"
    mark "SKIPPED lock-busy"
    exit 0
  fi
fi
echo $$ > "$LOCK_DIR/pid"

# Keep the Mac awake until this run ends. launchd starts runs in a brief
# background wake; on 30 September 2026 the Mac went back to sleep forty
# seconds into the 04:13 run, and when it woke at 04:29 every database
# connection was gone and the run failed - twice that morning. caffeinate -i
# holds off idle sleep (and -s system sleep on power) for as long as this
# shell lives. A closed lid on battery still sleeps; nothing can stop that.
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i -s -w $$ &
fi
trap 'rm -f "$LOCK_DIR/pid"; rmdir "$LOCK_DIR" 2>/dev/null' EXIT

cd "$REPO" || { log "FATAL: repo not found at $REPO"; mark "FAILED no-repo"; exit 1; }

if [ -d "$HOME/.nvm/versions/node" ]; then
  NEWEST_NODE="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
  [ -n "$NEWEST_NODE" ] && export PATH="$HOME/.nvm/versions/node/$NEWEST_NODE/bin:$PATH"
fi
# Where the standard Claude Code installer puts the CLI.
export PATH="$HOME/.local/bin:$PATH"
# Three database connections, whatever the scripts default to - the Supabase
# pooler has fifteen for the whole project (see src/db/pool.ts).
export OFFERLY_DB_POOL="${OFFERLY_DB_POOL:-3}"

# The database CA, from a path a background job can read. .env.local points at
# a copy inside Dropbox (~/Library/CloudStorage), and macOS blocks launchd jobs
# from cloud-storage folders - the first five scheduled runs on 29 September
# 2026 all died with "DATABASE_CA_CERT_FILE could not be read" while the same
# command worked from a terminal. Set here, it wins over .env.local (Node's
# --env-file never overrides a variable that is already set). The certificate
# is public - no private key - see DATABASE-TLS-RUNBOOK.md.
NEWS_CA="${NEWS_DATABASE_CA_CERT_FILE:-$HOME/.config/offerly/supabase-ca.crt}"
if [ -r "$NEWS_CA" ]; then
  export DATABASE_CA_CERT_FILE="$NEWS_CA"
else
  log "WARNING: no readable CA at $NEWS_CA; falling back to .env.local, which launchd may not be able to read"
fi

if ! command -v npm >/dev/null 2>&1; then
  log "FATAL: npm not on PATH"
  mark "FAILED no-npm"
  exit 1
fi

case "$MODE" in
  run) CMD=(npm run news:run) ;;
  desk) CMD=(npm run news:run -- --desk) ;;
  scout) CMD=(npm run news:scout) ;;
  *) log "unknown mode $MODE"; exit 1 ;;
esac

# Keep the Mac awake for the length of the run. On battery a laptop idles to
# sleep in minutes; on 29 September 2026 one slept eight minutes into a run,
# the model call timed out and the database connection died with it.
# caffeinate -i blocks idle sleep only while the command runs; closing the lid
# still sleeps the machine, and the next scheduled run picks up the rest.
if command -v caffeinate >/dev/null 2>&1; then
  CMD=(caffeinate -i "${CMD[@]}")
fi

log "starting $MODE with $(node --version)"
OUTPUT="$("${CMD[@]}" 2>&1)"
STATUS=$?
echo "$OUTPUT"

# The database guard's own refusal line, matched exactly (see scheduled-crawl.sh
# for what loose keyword matching cost).
if echo "$OUTPUT" | grep -q "REFUSING TO RUN"; then
  log "SKIPPED: the dev server holds the local database"
  mark "SKIPPED dev-server-running"
  exit 0
fi

if [ $STATUS -eq 2 ]; then
  log "AI-BLOCKED: collected and ranked, but the claude CLI could not label anything"
  mark "AI-BLOCKED $(echo "$OUTPUT" | grep -m1 STOPPED | sed 's/^ *//')"
  alert_if_failing
  exit 0
fi

if [ $STATUS -ne 0 ]; then
  log "FAILED: exited $STATUS"
  mark "FAILED status=$STATUS"
  alert_if_failing
  exit $STATUS
fi

THIN="$(echo "$OUTPUT" | grep -c 'THIN' || true)"
mark "OK thin-sectors=$THIN"
exit 0
