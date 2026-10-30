#!/bin/zsh
set -u
cd "/Users/kaiclauson/Developer/Offerly Bing Bong/.claude/worktrees/draft-pipeline-perf"
O="$1"
run () {  # name, extra flags
  local name="$1"; shift
  echo "=== ARM $name :: $* ==="
  npx tsx --conditions=react-server --env-file=.env.local scripts/draft-live-eval.ts "$O/$name.md" \
    --concurrency=1 --json="$O/$name-timings.json" --drafts-json="$O/$name-drafts.json" "$@" 2>&1 | tail -6
  echo "--- $name exit=$? ---"
}
run A-control
run B-medium-nothink --review-thinking=disabled
run C-low-nothink --review-effort=low --review-thinking=disabled
