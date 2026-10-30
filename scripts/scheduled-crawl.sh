#!/bin/bash
# The crawl, as launchd runs it.
#
# A wrapper rather than a command line inside the plist, for three reasons
# that each cost something the last time they were got wrong:
#
#   1. A SKIPPED RUN MUST BE LOUD. PGlite is single-writer, so the crawl
#      refuses to start while the dev server is up. Inside the plist that
#      refusal was a non-zero exit into a log nobody reads, and the honest
#      description of the result was "no crawl happened this week and nothing
#      said so". Here it is written to a marker file the audit can see.
#
#   2. NODE MUST NOT BE PINNED. The plist hardcoded
#      ~/.nvm/versions/node/v24.19.0/bin, so the first Node upgrade would have
#      broken the schedule silently - launchd logging "no such file or
#      directory" and nothing else. This resolves whatever nvm currently
#      points at, and falls back to the login shell's own PATH.
#
#   3. TWO CRAWLS MUST NOT OVERLAP. An hourly schedule plus a slow run is all
#      it takes, and two writers is the exact thing the guard exists to stop.
#
# Usage: scheduled-crawl.sh [crawl|weekly]
set -uo pipefail

REPO="/Users/kaiclauson/Developer/Offerly Bing Bong"
MODE="${1:-crawl}"
STATE_DIR="$HOME/offerly-audit"
LOCK_DIR="$STATE_DIR/crawl.lock"
MARKER="$STATE_DIR/last-scheduled-run.txt"

mkdir -p "$STATE_DIR"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# mkdir is atomic, which is the whole point - a test-then-create would race
# with exactly the second process this is meant to exclude.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "SKIPPED: another scheduled crawl is still running (lock at $LOCK_DIR)"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) SKIPPED overlapping-run" >> "$MARKER"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

cd "$REPO" || { log "FATAL: repo not found at $REPO"; exit 1; }

# nvm's current version, whatever it is today. The glob is sorted so the
# newest installed version wins when several are present.
if [ -d "$HOME/.nvm/versions/node" ]; then
  NEWEST_NODE="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
  [ -n "$NEWEST_NODE" ] && export PATH="$HOME/.nvm/versions/node/$NEWEST_NODE/bin:$PATH"
fi

if ! command -v npm >/dev/null 2>&1; then
  log "FATAL: npm not on PATH - Node may have been removed or relocated"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) FAILED no-npm" >> "$MARKER"
  exit 1
fi

log "starting ($MODE) with $(node --version)"

if [ "$MODE" = "weekly" ]; then
  # The ONLY step here that spends anything: a capped 25 model calls filling
  # in eligibility the deterministic parser could not read. Kept on its own
  # weekly schedule precisely so the hourly crawl stays free - putting it in
  # the hourly job would be 600 calls a day to learn almost nothing new.
  npx tsx --env-file=.env.local --conditions=react-server scripts/backfill-eligibility.ts --limit 25 --apply
  STATUS=$?
  log "weekly eligibility pass finished with status $STATUS"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) weekly status=$STATUS" >> "$MARKER"
  exit $STATUS
fi

# Firms added to the directory since the last run become monitored sources
# before the crawl picks sources, so a firm added at any point in the hour is
# crawled in this pass rather than whenever somebody next remembers to run the
# seeder. Bounded to 30 firms a pass and ~5 requests each; a firm whose
# careers page cannot be found is refused and recorded, never enrolled against
# its homepage. See scripts/enrol-new-firms.ts for why that refusal matters.
#
# Not allowed to fail the crawl: enrolment is an improvement to the next pass,
# and a crawl that refuses to run because a firm's website was unreachable
# would be a worse trade than crawling one firm late.
npx tsx --env-file=.env.local --conditions=react-server scripts/enrol-new-firms.ts --limit 30 || \
  log "enrolment pass failed (continuing to the crawl)"

# The crawl itself. monitor-run only fetches sources whose nextCheckAt is due,
# so running hourly does NOT mean crawling everything hourly - it means the
# per-source tiers finally decide the cadence they were always written to
# decide. A bulge-bracket source on a 60 minute tier was being checked weekly
# before this, which made the whole tier table decorative.
#
# --limit 500, not 110. 110 was "every source" when there were 110; after
# enrolment there are ~5,100, and the cap left every sector but IB unchecked
# for days. 500 is about ten minutes of crawling, well inside the hour, and
# monitor-run fills it in-season sectors first (see seasonBand in season.ts).
OUTPUT="$(npm run monitor:run -- --limit 500 2>&1)"
STATUS=$?
echo "$OUTPUT"

# The guard's refusal, told apart from every other failure. This is the case
# that used to vanish.
# Matches the guard's ACTUAL refusal line, not loose keywords.
#
# This used to grep for "dev server|single-writer|exclusive" anywhere in the
# output - and the output contains every listing title the crawl saw. A firm
# called Exclusive Networks, or any role with "exclusive" in it, would make a
# completed crawl report itself as skipped. The guard prints one specific
# sentence; match that.
if echo "$OUTPUT" | grep -q "REFUSING TO RUN"; then
  log "SKIPPED: the dev server is running, so the crawl refused to open the database"
  log "         This is correct behaviour - but it means no crawl happened."
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) SKIPPED dev-server-running" >> "$MARKER"
  exit 0
fi

if [ $STATUS -ne 0 ]; then
  log "FAILED: monitor:run exited $STATUS"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) FAILED monitor-run status=$STATUS" >> "$MARKER"
  exit $STATUS
fi

npx tsx --env-file=.env.local --conditions=react-server scripts/promote-approved-listings.ts
PROMOTE=$?

log "finished: crawl ok, promote status $PROMOTE"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) OK promote=$PROMOTE" >> "$MARKER"
exit 0
