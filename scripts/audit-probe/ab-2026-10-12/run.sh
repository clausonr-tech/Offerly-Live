#!/bin/zsh
set -u
ROOT="/Users/kaiclauson/Developer/Offerly Bing Bong/.claude/worktrees"
OUT="$1"
hashes () {
  local w="$1"
  for f in src/lib/draft-prompt.ts src/lib/draft-review.ts src/lib/draft-lint.ts src/lib/email-examples.ts src/lib/email-examples-v3.json src/lib/email-examples-v4.json src/lib/draft-templates.ts src/lib/draft-occasions.ts scripts/draft-cli-eval.ts scripts/draft-occasions-sim.ts; do
    [ -f "$ROOT/$w/$f" ] && md5 -q "$ROOT/$w/$f" | tr -d '\n' && echo "  $f"
  done
}
for w in draft-baseline-pretoday draft-pipeline-perf; do
  echo "### HASHES BEFORE $w"; hashes "$w"
done > "$OUT/hashes-before.txt"

for w in draft-baseline-pretoday draft-pipeline-perf; do
  for p in full sparse; do
    tag="${w%%-*}"; [ "$w" = "draft-baseline-pretoday" ] && tag=base || tag=new
    echo "=== $tag $p ==="
    ( cd "$ROOT/$w" && npx tsx --conditions=react-server scripts/draft-cli-eval.ts --scenarios=16 --seed=quality --profile=$p \
        --retry-before=600000 --concurrency=4 --quiet --json="$OUT/$tag-$p.json" ) 2>&1 | tail -25
    echo "--- exit=$? ---"
  done
done

for w in draft-baseline-pretoday draft-pipeline-perf; do
  echo "### HASHES AFTER $w"; hashes "$w"
done > "$OUT/hashes-after.txt"
if diff -q "$OUT/hashes-before.txt" "$OUT/hashes-after.txt" >/dev/null; then
  echo "HASHES UNCHANGED - run is valid"
else
  echo "** HASHES MOVED MID-RUN - THIS RUN IS VOID **"; diff "$OUT/hashes-before.txt" "$OUT/hashes-after.txt"
fi
