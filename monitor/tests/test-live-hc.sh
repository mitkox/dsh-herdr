#!/bin/bash
# Read-only live test inside an isolated herdr-core:
#  - dsh-herdr watches your REAL ~/.dsh/sessions (never writes to them)
#  - dsh-watch watches one real live session
# No DSH host is contacted, no session is prompted, nothing is restarted.
#
# Prereq: isolated core running (HC_SESSION=probe4 + scratch XDG dirs; see
# tests/test-synthetic-herdr.sh header).
set -euo pipefail
MON="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${LIVE_OUT:-/tmp/probe4/live-evidence}"
SESS="${DSH_HOME:-$HOME/.dsh}/sessions"
rm -rf "$OUT"; mkdir -p "$OUT"
step() { printf '\n=== %s ===\n' "$*"; }
summarize() { node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const j=JSON.parse(b);console.log("  reported="+j.reported+" state="+(j.status&&j.status.state)+" kind="+(j.status&&j.status.kind||"-")+" title="+(j.status&&j.status.title||"-")+" msg="+(j.status&&j.status.msg||"-")+" turn="+j.turn)})'; }

step "dsh-herdr: watch ALL real sessions (read-only)"
hc run --bg --name dsh-herdr-live node "$MON/dsh-herdr.mjs" \
  --sessions-dir "$SESS" --state-file "$OUT/state-live.json" \
  --poll-ms 400 --rescan-ms 1500 >/dev/null
sleep 5
hc get dsh-herdr-live | tee "$OUT/get-live-all.json" | summarize
sleep 2
hc get dsh-herdr-live | tee "$OUT/get-live-all-2.json" | summarize
cp "$OUT/state-live.json" "$OUT/state-live-snapshot.json" 2>/dev/null || true
printf '\n--- state file (first 24 lines) ---\n'
head -24 "$OUT/state-live.json"

step "dsh-watch: one real live session (newest active journal)"
hc run --bg --name dsh-watch-live node "$MON/dsh-watch.mjs" \
  --history 6 --poll-ms 300 >/dev/null
sleep 4
hc get dsh-watch-live | tee "$OUT/get-live-one.json" | summarize
hc read --lines 40 dsh-watch-live | tee "$OUT/feed-live-watch.txt" | tail -24

step "aggregate feed from dsh-herdr"
hc read --lines 60 dsh-herdr-live | tee "$OUT/feed-live-herdr.txt" | tail -30

step "cleanup"
for t in dsh-herdr-live dsh-watch-live; do hc kill "$t" >/dev/null 2>&1 || true; hc rm "$t" >/dev/null 2>&1 || true; done
printf '\nEvidence saved under %s\n' "$OUT"
