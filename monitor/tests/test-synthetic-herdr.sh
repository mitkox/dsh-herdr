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
PANE="dsh-herdr-test-$$"
J="$SB/sessions/demo/demo-0001/session.v4.jsonl.zstd"
OUT="$SB/evidence"
rm -rf "$SB"; mkdir -p "$(dirname "$J")" "$OUT"
step() { printf '\n=== %s ===\n' "$*"; }
append() { node "$MON/tests/make-session.mjs" event "$J" "$@" >/dev/null; }
get() {
  hc get "$PANE" | tee "$OUT/get-$1.json" | node -e '
    const assert = require("node:assert/strict")
    const fs = require("node:fs")
    const [expected, kind, file] = process.argv.slice(1)
    let input = ""
    process.stdin.on("data", chunk => input += chunk).on("end", () => {
      const terminal = JSON.parse(input)
      assert.equal(terminal.reported, true, "terminal must report OSC status")
      assert.equal(terminal.status?.state, expected, `expected ${expected} terminal state`)
      assert.equal(terminal.status?.kind ?? "", kind)
      const state = JSON.parse(fs.readFileSync(file, "utf8"))
      assert.equal(state.aggregate.state, expected)
      assert.equal(state.sessions[0].status, expected)
      if (kind) assert.equal(state.sessions[0].blockedReason, kind)
      console.log(`  verified ${expected}${kind ? "/" + kind : ""}`)
    })
  ' "$2" "${3:-}" "$SB/state.json"
}
cleanup() {
  hc kill "$PANE" >/dev/null 2>&1 || true
  hc rm "$PANE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "fixture: idle session, dsh-herdr starts"
node "$MON/tests/make-session.mjs" init "$J" demo-0001 /home/you/src/example "Fix the failing test" >/dev/null
hc run --bg --name "$PANE" env DSH_HOME="$SB" node "$MON/../bin/dsh-herdr" watch \
  --state "$SB/state.json" --interval 150 >/dev/null
sleep 1.5
get idle idle
cat "$SB/state.json" | head -30

step "turn starts + bash tool call -> working"
append turn/start '{"turn":1}' 10
append tool/call '{"turn":1,"step":1,"callId":"call_a","name":"bash","arguments":"{\"command\":\"npm test -- --run\"}"}' 11
sleep 0.8
get working working
cp "$SB/state.json" "$OUT/state-working.json"

step "approval needed -> blocked(permission)"
append approval/asked '{"id":"appr_1","toolName":"bash","callId":"call_a","reason":"runs a command"}' 12
sleep 0.8
get blocked-approval blocked permission
cp "$SB/state.json" "$OUT/state-blocked-approval.json"

step "approval decided, tool done, turn ends -> idle"
append approval/decided '{"id":"appr_1","outcome":"allowed-once"}' 13
append tool/result '{"turn":1,"step":1,"message":{"role":"tool","source":{"kind":"tool","callId":"call_a"},"toolCallId":"call_a","content":[{"type":"text","text":"ok"}]}}' 14
append turn/end '{"turn":1,"reason":{"kind":"done"}}' 15
sleep 0.8
get idle-after-turn idle
cat "$SB/state.json" | head -30

step "question pending -> blocked(question)"
append turn/start '{"turn":2}' 16
append tool/call '{"turn":2,"step":1,"callId":"call_q","name":"ask_user_question","arguments":"{\"questions\":[{\"id\":\"q1\",\"question\":\"Pick a branch strategy\"}]}"}' 17
sleep 0.8
get blocked-question blocked question
cp "$SB/state.json" "$OUT/state-blocked-question.json"

step "question answered -> turn ends -> idle"
append tool/result '{"turn":2,"step":1,"message":{"role":"tool","source":{"kind":"tool","callId":"call_q"},"toolCallId":"call_q","content":[{"type":"text","text":"chosen: rebase"}]}}' 18
append turn/end '{"turn":2,"reason":{"kind":"done"}}' 19
sleep 0.8
get idle-question-done idle

step "feed (hc read)"
hc read --lines 60 "$PANE" | tee "$OUT/feed.txt" | tail -45

step "cleanup"
cleanup
printf '\nEvidence saved under %s\n' "$OUT"
