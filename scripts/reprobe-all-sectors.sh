#!/bin/bash
#
# Re-probe every finance sector for job boards, with the platforms the prober
# could not see before 20 September 2026.
#
# WHY THIS EXISTS
# ---------------
# `ats-probe.ts` knew Greenhouse, Lever, Ashby and five others, and NOTHING
# about Dayforce, BambooHR or Jobvite. Every probe ever run reported firms on
# those platforms as having no board - not as unknown, as absent. Checking the
# stored probe files on 20 September:
#
#   private_equity   2,882 firms probed, 30 hits,   6 platforms
#   hedge_fund       1,928 firms probed, 20 hits,   7 platforms
#   other_finance    1,238 firms probed,  5 hits,   7 platforms
#   venture_capital    550 firms probed, 18 hits, 6-7 platforms
#   real_estate        420 firms probed,  4 hits,   6 platforms
#   private_credit      80 firms probed,  0 hits,   7 platforms
#
# Every one predates the fix. The prober now defines twelve platforms and
# treats TEN of them as probable - the other two are excluded because a 200
# is not proof of a board there. So roughly 7,100 firms were asked a
# question missing three or four of the ten, and private_credit's flat zero
# - the reason that sector has no sources at all - is a measurement, not a
# finding.
#
# Six sectors have never been probed at ALL: consulting, commercial_banking,
# insurance, fintech, market_infrastructure and sales_trading.
#
# ORDER IS DELIBERATE. The sectors with no sources go first, smallest first,
# because they are the actual coverage gap and they are cheap - roughly 1,550
# firms between them against 11,000 for the sectors that already have sources.
# A sweep that spends its first ten hours re-probing private equity answers
# the least interesting question first.
#
# This replaces the chained script from the 19/20 September session, which
# waited on the AWM probe's PID and died with that session's shell, leaving
# nothing to run when the probe finished.
#
# NO DATABASE. probe-boards.ts reads the directory from JSON and writes a
# proposals file; applying them is a separate, reviewed step
# (scripts/apply-probed-boards.ts).
#
#   bash scripts/reprobe-all-sectors.sh            # skip what is already current
#   bash scripts/reprobe-all-sectors.sh --force    # re-probe everything
#
set -u

cd "$(dirname "$0")/.." || exit 1

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

LOG="scripts/data/reprobe.log"
say() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

# The platform count a stored probe file was generated with, or 0 if the file
# is missing, unreadable, or probed nothing.
#
# A run that probed ZERO firms counts as 0 however many platforms it lists.
# probe-boards.ts skips firms that already have a careers URL, so a category
# whose firms all have one produces a perfectly valid file reporting nothing -
# and taking that as "already done at 10 platforms" would skip the category
# for good. Consulting is exactly that case: two firms, both with careers URLs,
# nothing to probe.
platforms_in() {
  node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const n=Number(d.firmsProbed)||0;process.stdout.write(String(n>0&&Array.isArray(d.platforms)?d.platforms.length:0))}catch(e){process.stdout.write("0")}' "$1" 2>/dev/null
}

# If the asset & wealth management probe is still running, wait for it rather
# than competing with it for the same vendor hosts. Matched by command line,
# not by a PID recorded in a previous session - that is exactly what broke
# last time.
wait_for_awm() {
  local pid
  pid=$(pgrep -f "probe-boards.ts --category asset_wealth_management" | tail -1)
  if [ -n "$pid" ]; then
    say "asset_wealth_management probe is running (pid $pid) - waiting for it"
    while kill -0 "$pid" 2>/dev/null; do sleep 60; done
    say "asset_wealth_management probe finished"
  fi
}

# Smallest first within each group, so the cheap answers land early.
EMPTY_SECTORS="consulting market_infrastructure fintech insurance sales_trading private_credit commercial_banking"
# asset_wealth_management belongs here too, and was missed on the first
# version of this script because its probe was still running when the script
# was written. That probe finished on 20 September 2026 having read 7,436
# firms in 15.2 hours - and having used SEVEN platforms, because it was
# launched before Dayforce, BambooHR and Jobvite were added. It found 41
# boards. Leaving it out of both lists meant the largest sector in the
# directory, 8,345 firms with a careers URL, would never be asked the full
# question. The platform check below is what makes redoing it cheap to decide
# and impossible to forget.
COVERED_SECTORS="asset_wealth_management real_estate investment_banking venture_capital other_finance hedge_fund private_equity"

probe() {
  category="$1"
  out="scripts/data/probed-$(echo "$category" | tr '_' '-').json"

  # Skipping is decided by whether the stored answer asked the FULL question,
  # not by whether a file happens to exist. Every file on disk was generated
  # with six or seven of the ten probable platforms, so "exists" would skip
  # exactly the files this script was written to redo.
  if [ -f "$out" ] && [ "$FORCE" -eq 0 ]; then
    had=$(platforms_in "$out")
    if [ "${had:-0}" -ge "$CURRENT_PLATFORMS" ] 2>/dev/null; then
      say "skip $category - already probed with $had platforms"
      return 0
    fi
    say "redo $category - stored answer used ${had:-0} of $CURRENT_PLATFORMS platforms"
  fi

  say "probing $category -> $out"
  if npx tsx --conditions=react-server scripts/probe-boards.ts \
      --category "$category" --limit 9000 --out "$out" >>"$LOG" 2>&1; then
    say "done $category ($(platforms_in "$out") platforms)"
  else
    # One category failing must not end the sweep - the next is independent,
    # and a partial answer for thirteen sectors beats none for any.
    say "FAILED $category (continuing)"
  fi
}

# How many platforms the prober knows RIGHT NOW. Asked of the code rather than
# hardcoded, so this script cannot drift from ats-probe.ts the way the stored
# probe files did.
CURRENT_PLATFORMS=$(npx tsx --conditions=react-server -e 'import{probablePlatforms}from"./src/lib/monitoring/ats-probe";console.log(probablePlatforms().length)' 2>/dev/null | tail -1)
if ! [ "${CURRENT_PLATFORMS:-0}" -gt 0 ] 2>/dev/null; then
  say "could not read the platform count from ats-probe.ts - aborting"
  exit 1
fi

say "=== re-probe starting: $CURRENT_PLATFORMS platforms, all 14 sectors ==="
wait_for_awm

say "--- sectors with no sources at all ---"
for c in $EMPTY_SECTORS; do probe "$c"; done

say "--- sectors that already have sources, re-probed for the new platforms ---"
for c in $COVERED_SECTORS; do probe "$c"; done

say "=== re-probe complete ==="
say "Review the files, then apply with scripts/apply-probed-boards.ts"
