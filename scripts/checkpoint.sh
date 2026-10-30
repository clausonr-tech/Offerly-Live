#!/usr/bin/env bash
#
# Take a restorable checkpoint of the things git does not cover.
#
#   scripts/checkpoint.sh "why I am taking this"
#
# Git already versions every file in the repo, so a checkpoint's job is the
# rest: the PGlite database, and a note of exactly which commit the code was on
# when the snapshot was taken. Restoring both together is what makes a rollback
# coherent - a database from one point with code from another is a state that
# never existed.
#
# WHAT THIS CANNOT DO
# -------------------
# Nothing here undoes an outbound effect. An email sent, an API call made, a
# push to origin, a published posting - a snapshot records that it happened and
# cannot unhappen it. Those are the actions worth a confirmation prompt even
# when permissions are set to bypass.
set -euo pipefail

# Derived from this script's own location rather than hardcoded: an absolute
# home path in a committed file is both non-portable and a username nobody
# needs in git history.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT="$HOME/offerly-audit"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$AUDIT/snapshots/$STAMP"
REASON="${1:-no reason given}"

cd "$REPO"

# The dev server holding PGlite open is what corrupted the database once
# already. Copying while it writes risks a torn snapshot, which is worse than
# no snapshot because it looks like a good one.
DEV_PORT="$(grep -o -- '--port[= ][0-9]*' package.json | grep -o '[0-9]*' | head -1 || echo 3000)"
if lsof -i ":$DEV_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "REFUSING: something is listening on port $DEV_PORT (the dev server)."
  echo "A database copied while another process writes to it is a torn snapshot."
  echo "Stop the dev server, then run this again."
  exit 1
fi

# Which data directory is live. Mirrors src/db/client.ts's pgliteDataDir().
DB_DIR="${PGLITE_DATA_DIR:-./local-data/pglite-v3}"

# A snapshot is ~110MB and this machine sits near full - measured at 97% used,
# 7.5GiB free, on 19 Sep. A rollback tool that fills the disk has caused a
# worse problem than the one it was insuring against, so refuse rather than
# limp, and say the number.
FREE_MB="$(df -m "$HOME" | awk 'NR==2 {print $4}')"
NEED_MB="$(du -sm "$DB_DIR" 2>/dev/null | cut -f1 || echo 200)"
MIN_FREE_MB=2048
if [ "$FREE_MB" -lt $(( NEED_MB + MIN_FREE_MB )) ]; then
  echo "REFUSING: ${FREE_MB}MB free, and this snapshot needs ~${NEED_MB}MB plus a ${MIN_FREE_MB}MB floor."
  echo ""
  echo "Free some space, then run this again. Candidates, largest first:"
  du -sh "$AUDIT/snapshots"/* 2>/dev/null | sort -rh | head -5
  echo "  (and $REPO/local-data/, which keeps its own backups)"
  exit 1
fi

# Keep the last few and drop the rest. Unbounded snapshots on a disk this full
# is the same failure in slow motion.
KEEP=3
if [ -d "$AUDIT/snapshots" ]; then
  # shellcheck disable=SC2012
  ls -1dt "$AUDIT/snapshots"/*/ 2>/dev/null | tail -n +$(( KEEP + 1 )) | while read -r old; do
    echo "  pruning older snapshot $(basename "$old")"
    rm -rf "$old"
  done
fi

mkdir -p "$DEST"

echo "checkpoint $STAMP"
echo "  reason:  $REASON"

if [ -d "$DB_DIR" ]; then
  cp -R "$DB_DIR" "$DEST/db"
  echo "  database: $DB_DIR -> $DEST/db ($(du -sh "$DEST/db" | cut -f1))"
else
  echo "  database: $DB_DIR not found - nothing copied"
fi

# The code side is a reference, not a copy: the commit is already in git, and
# duplicating the tree would waste gigabytes to store what git holds better.
# Uncommitted work is the exception - that exists nowhere else, so it is saved
# as a patch.
{
  echo "reason:  $REASON"
  echo "when:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "branch:  $(git rev-parse --abbrev-ref HEAD)"
  echo "commit:  $(git rev-parse HEAD)"
  echo "db_dir:  $DB_DIR"
  echo ""
  echo "--- git status at checkpoint ---"
  git status --short
} > "$DEST/MANIFEST.txt"

git diff HEAD > "$DEST/uncommitted.patch" || true
if [ -s "$DEST/uncommitted.patch" ]; then
  echo "  uncommitted changes saved to $DEST/uncommitted.patch"
else
  rm -f "$DEST/uncommitted.patch"
  echo "  working tree clean - no patch needed"
fi

echo "  manifest: $DEST/MANIFEST.txt"
echo ""
echo "To roll back to this point, see $AUDIT/README.md"
