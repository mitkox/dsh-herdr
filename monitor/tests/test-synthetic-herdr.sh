#!/bin/bash
# Deterministic end-to-end test of dsh-herdr inside an ISOLATED herdr-core.
# Proves OSC 7501 state transitions (idle -> working -> blocked -> idle) and the
# state JSON, using a synthetic session journal (no DSH host, no model turns).
#
# Prereq: isolated core running, e.g.
#   export HC_SESSION=probe4 XDG_STATE_HOME=/tmp/probe4/state \
#     XDG_CONFIG_HOME=/tmp/probe4/config XDG_DATA_HOME=/tmp/probe4/data \
#     XDG_RUNTIME_DIR=/tmp/probe4/run
#   hc server start
set -euo pipefail
MON="$(cd "$(dirname "$0")/.." && pwd)"
SB="${SYNTH_DIR:-/tmp/probe4/synth}"
J="$SB/sessions/demo/demo-0001/session.v4.jsonl.zstd"
OUT="$SB/evidence"
rm -rf "$SB"; mkdir -p "$(dirname "$J")" "$OUT"
step() { printf '\n=== %s ===\n' "$*"; }
append() { node "$MON/tests/make-session.mjs" event "$J" "$@" >/dev/null; }
get() { hc get dsh-herdr | tee "$OUT/get-$1.json" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const j=JSON.parse(b);console.log("  reported="+j.reported+" state="+(j.status&&j.status.state)+" kind="+(j.status&&j.status.kind||"-")+" title="+(j.status&&j.status.title||"-")+" msg="+(j.status&&j.status.msg||"-")+" turn="+j.turn)})'; }

step "fixture: idle session, dsh-herdr starts"
node "$MON/tests/make-session.mjs" init "$J" demo-0001 /home/you/src/example "Fix the failing test" >/dev/null
hc run --bg --name dsh-herdr node "$MON/dsh-herdr.mjs" \
  --sessions-dir "$SB/sessions" --state-file "$SB/state.json" \
  --poll-ms 150 --rescan-ms 400 >/dev/null
sleep 1.5
get idle
cat "$SB/state.json" | head -30

step "turn starts + bash tool call -> working"
append turn/start '{"turn":1}' 10
append tool/call '{"turn":1,"step":1,"callId":"call_a","name":"bash","arguments":"{\"command\":\"npm test -- --run\"}"}' 11
sleep 0.8
get working
cp "$SB/state.json" "$OUT/state-working.json"

step "approval needed -> blocked(permission)"
append approval/asked '{"id":"appr_1","toolName":"bash","callId":"call_a","reason":"runs a command"}' 12
sleep 0.8
get blocked-approval
cp "$SB/state.json" "$OUT/state-blocked-approval.json"

step "approval decided, tool done, turn ends -> idle"
append approval/decided '{"id":"appr_1","outcome":"allowed-once"}' 13
append tool/result '{"turn":1,"step":1,"message":{"role":"tool","source":{"kind":"tool","callId":"call_a"},"toolCallId":"call_a","content":[{"type":"text","text":"ok"}]}}' 14
append turn/end '{"turn":1,"reason":{"kind":"done"}}' 15
sleep 0.8
get idle-after-turn
cat "$SB/state.json" | head -30

step "question pending -> blocked(question)"
append turn/start '{"turn":2}' 16
append tool/call '{"turn":2,"step":1,"callId":"call_q","name":"ask_user_question","arguments":"{\"questions\":[{\"id\":\"q1\",\"question\":\"Pick a branch strategy\"}]}"}' 17
sleep 0.8
get blocked-question
cp "$SB/state.json" "$OUT/state-blocked-question.json"

step "question answered -> turn ends -> idle"
append tool/result '{"turn":2,"step":1,"message":{"role":"tool","source":{"kind":"tool","callId":"call_q"},"toolCallId":"call_q","content":[{"type":"text","text":"chosen: rebase"}]}}' 18
append turn/end '{"turn":2,"reason":{"kind":"done"}}' 19
sleep 0.8
get idle-question-done

step "feed (hc read)"
hc read --lines 60 dsh-herdr | tee "$OUT/feed.txt" | tail -45

step "cleanup"
hc kill dsh-herdr >/dev/null 2>&1 || true
hc rm dsh-herdr >/dev/null 2>&1 || true
printf '\nEvidence saved under %s\n' "$OUT"
