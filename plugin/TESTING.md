# TESTING — herdr-status end-to-end probe

Everything below was run on this machine on 2026-11-04. You's live
`web` host (port 3080), `herdr-core`, and `herdr-app` were never restarted,
stopped, or modified. All probes used an isolated Herdr session and a scratch
DSH home.

## Environment

| Component | Value |
|---|---|
| DSH (`dsh --version`) | `0.2.2-rc.1` (installed mise npm package) |
| `hc --version` | `hc 0.1.17` |
| `herdr-app --version` | `herdr-app 0.1.12` |
| Isolated Herdr session | `HC_SESSION=probe2`, `XDG_{STATE,CONFIG,DATA,RUNTIME}_HOME=/tmp/probe2/*` (own herdr-core, own terminals) |
| Scratch DSH home | `DSH_HOME=/tmp/herdr-e2e/home`, new profile `herdr-probe` |
| Scratch port | `3181` (user web on 3080 untouched) |
| Model | scriptable mock Messages server, **no real model calls** (`packages/test-support/llm-mock-server`), `DEEPSEEK_BASE_URL=http://127.0.0.1:18000/v1`, `DEEPSEEK_API_KEY=mock-key` |
| State file override | `DSH_HERDR_STATE=/tmp/herdr-e2e/evidence/agents.json` so the probe never races your canonical launcher file |

The scratch profile was created from scratch (no shipped template): bundles
`@deepseek-ai/dsh-base`, `dsh-plugin-herdr`, `@deepseek-ai/dsh-web-app`, with
`session-title-llm` disabled in the profile patch layer so title generation did
not consume scripted mock responses. The profile's own layer:

```yaml
- id: session-title-llm
  disabled: true
```

## 1. Install (the documented path)

```sh
$ DSH_HOME=/tmp/herdr-e2e/home dsh plugin --profile herdr-probe add \
    /home/you/src/dsh-plugin
dsh: initialized profile herdr-probe at /tmp/herdr-e2e/home/profiles/herdr-probe
+ dsh-plugin-herdr <- ../../../../../home/you/src/dsh-plugin
Done
```

`package.json` after the install — the plugin bundle activated automatically
(profile plugin reconciliation adds packages that declare `dsh.bundle.patch`):

```json
{
  "dependencies": { "dsh-plugin-herdr": "link:/home/you/src/dsh-plugin" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-plugin-herdr"] } }
}
```

(`install.sh` additionally appends `@deepseek-ai/dsh-web-app` for a fresh
profile; in this probe it was appended by hand.)

## 2. Boot the host inside the isolated Herdr pane

```sh
export HC_SESSION=probe2 XDG_STATE_HOME=/tmp/probe2/state XDG_CONFIG_HOME=/tmp/probe2/config \
       XDG_DATA_HOME=/tmp/probe2/data XDG_RUNTIME_DIR=/tmp/probe2/run
hc run --bg --name dsh-host --cwd /tmp/herdr-e2e -- \
  env DSH_HOME=/tmp/herdr-e2e/home \
      DSH_HERDR_STATE=/tmp/herdr-e2e/evidence/agents.json \
      DEEPSEEK_BASE_URL=http://127.0.0.1:18000/v1 DEEPSEEK_API_KEY=mock-key \
      dsh --profile herdr-probe --port 3181 --no-open
# -> {"address":"t8","name":"dsh-host","state":"live"}
```

The plugin wrote OSC 7501 on its stdout (the pane's pty) once it mounted; Herdr
parsed it and the terminal became an agent:

```console
$ hc get dsh-host --json   # idle before any session exists
{
  "address": "t8",
  "name": "dsh-host",
  "state": "live",
  "status": { "app": "dsh-tui", "state": "idle" },
  "turn": 0,
  "reported": true
}
```

Evidence: `evidence/hc-get-idle.json`.

## 3. Driving a turn (cookie/token flow verified against 0.2.2-rc.1)

The tokenized URL is printed to the host's stdout; the Probe used
`hc read dsh-host` to capture it:

```
dsh web: http://127.0.0.1:3181/?token=<token>
```

Auth + RPC facts (all verified, used by `test/drive.mjs`):

1. `GET http://127.0.0.1:3181/?token=<token>` → `303` + `Set-Cookie: dsh-auth-...` (browser-session cookie).
2. Every API call is `POST http://127.0.0.1:3181/api/<namespace>/<method>` with the cookie and envelope
   `{"type":"client-request","rpcId":"...","method":"<namespace>/<method>","payload":{"args":{...}}}`.
   The response is `{"type":"server-response","rpcId":"...","result":{"ok":true,"value":...}}` (or `ok:false,error`).
3. Endpoints used: `session/create` (`args: {request:{cwd, agentPreset}}`),
   `session/prompt` (`args: {request:{requestId, sessionId, mode:"queue", content:[{type:"text",text}]}}`),
   `session/cancel` (`args: {request:{sessionId}}`). Arguments are the endpoint
   method's named parameters (`request`), not a flat payload.

```sh
node test/drive.mjs --base-url http://127.0.0.1:3181 --token "$TOKEN" \
  --cwd /tmp/herdr-e2e/work --state-file /tmp/herdr-e2e/evidence/agents.json \
  --prompt "PHASE ONE respond with the long mock answer" --mode simple
```

While the probe ran, a sampler polled `hc get dsh-host --json` and the state
document every 200 ms into `evidence/timeline-*.jsonl`.

## 4. Evidence A — `working -> idle` visible to herdr-core

Mock script: one `slow_success` response (streamed in chunks over ~2.9 s).
Condensed `hc get` + state-document samples from
`evidence/timeline-working-idle.jsonl`:

```jsonc
// idle, no session
{"ts":1793793092275,"hc":{"state":"idle","app":"dsh-tui","title":"PHASE TWO ask the user","turn":0},
 "aggregate":{"state":"idle","title":"PHASE TWO ask the user","working":0}}
// turn running: OSC working + title + msg
{"ts":1793793097138,"hc":{"state":"working","app":"dsh-tui","title":"PHASE ONE respond with the","msg":"thinking","turn":0},
 "aggregate":{"state":"working","title":"PHASE ONE respond with the","msg":"thinking","working":1}}
// turn finished: OSC idle; Herdr incremented its per-terminal turn counter
{"ts":1793793099974,"hc":{"state":"idle","app":"dsh-tui","title":"PHASE ONE respond with the","turn":1},
 "aggregate":{"state":"idle","title":"PHASE ONE respond with the","working":0}}
```

Also from `test/drive.mjs` (state-document observation):

```jsonc
{"phase":"turn:observed","state":"working","activity":"thinking","aggregate":{"state":"working","title":"PHASE ONE respond with the","msg":"thinking","working":1}}
{"phase":"turn:observed","state":"idle","activity":"waiting for activity…","aggregate":{"state":"idle","title":"PHASE ONE respond with the","msg":null,"working":0}}
{"phase":"done"}
```

## 5. Evidence B — `blocked -> idle` visible to herdr-core

Mock script: a `tool_call_success` response whose tool call is
`ask_user_question` with one question and two options. No client was connected
to answer, so the question stayed pending and the plugin reported
`blocked`/`kind=question`. After a 4 s hold the probe called `session/cancel`;
the pending question was cancelled, the turn closed, and the report returned to
`idle`. Condensed samples from `evidence/timeline-blocked.jsonl`:

```jsonc
{"ts":1793793064706,"hc":{"state":"idle","turn":0},"aggregate":{"state":"idle","working":0}}
{"ts":1793793068331,"hc":{"state":"blocked","kind":"question","app":"dsh-tui",
  "title":"PHASE TWO ask the user","msg":"Proceed with the herdr probe approval test?","turn":0},
 "aggregate":{"state":"blocked","title":"PHASE TWO ask the user","working":1}}
{"ts":1793793072631,"hc":{"state":"idle","app":"dsh-tui","title":"PHASE TWO ask the user","turn":0},
 "aggregate":{"state":"idle","working":0}}
```

`test/drive.mjs` output for the same phase (`evidence/drive-blocked3.jsonl`):
`blocked-captured` → `cancel` → `idle-after-cancel:observed` → `done`.

This proves the blocked state, the `kind=question` field, the question text in
`msg`, the aggregate precedence, and the blocked→idle transition end to end.

## 6. What is proven vs. not proven

Proven empirically:

- plugin mounts in a fresh profile from `dsh plugin add <path>` (bundle auto-activated);
- OSC 7501 sent from the host process reaches herdr-core in a Herdr pane:
  `hc get` reports `app=dsh-tui`, `state=idle|working|blocked`, `kind=question`,
  decoded `title`/`msg` (base64) — and Herdr increments its turn counter when the
  terminal leaves `working`;
- state document written atomically at the configured path with the documented
  schema (sessions, aggregate, host facts, cwd/preset/depth/turn/lastTurnEndMs);
- idle/working/blocked aggregation, multi-session records (two sessions visible
  in the snapshot), title/activity updates, and graceful `session/cancel` handling.

Not proven here (explicit gaps):

- **Real provider model**: a scriptable mock server replaced the model, so no real
  LLM/tool latency or streaming was exercised.
- **Permission-approval blocked path**: the plugin implements it from the durable
  `approval/asked` / `approval/decided` audit events, but the probe could not
  trigger an approval prompt in this composition (an escalating `bash` call did
  not request approval in the scratch profile), so only the question side
  (`kind=question`) is demonstrated. In your host, permission prompts
  appear when the browser/UI answers them; the same code path then reports
  `blocked` + `kind=permission`.
- **Host restart activation**: the plugin is loaded at boot, so it takes effect
  after the user restarts `dsh` in its Herdr pane; this probe proves the
  plugin works in a restarted host, not the live-host migration itself.
- **Dispose/reload**: listener cleanup and final flush are implemented with
  `ctx.effect`, but HMR/reload behaviour was not separately exercised.

## 7. Reproduce

```sh
# 1. isolated Herdr core + session
export HC_SESSION=probe2 XDG_STATE_HOME=/tmp/probe2/state XDG_CONFIG_HOME=/tmp/probe2/config \
       XDG_DATA_HOME=/tmp/probe2/data XDG_RUNTIME_DIR=/tmp/probe2/run
mkdir -p /tmp/probe2/{state,config,data,run}; chmod 700 /tmp/probe2/run
hc server status

# 2. scratch DSH home + install
DSH_HOME=/tmp/herdr-e2e/home plugin/install.sh --profile herdr-probe

# 3. mock model (no network)
node /home/you/src/deepseek-harness/packages/test-support/llm-mock-server/src/bin.ts \
  --port 18000 --api-key mock-key --sequence slow_success,success \
  --success-text "long mock answer ..." --chunk-size 8 --chunk-delay-ms 100 &

# 4. host in the isolated pane
hc run --bg --name dsh-host --cwd /tmp/herdr-e2e -- \
  env DSH_HOME=/tmp/herdr-e2e/home DSH_HERDR_STATE=/tmp/herdr-e2e/evidence/agents.json \
      DEEPSEEK_BASE_URL=http://127.0.0.1:18000/v1 DEEPSEEK_API_KEY=mock-key \
      dsh --profile herdr-probe --port 3181 --no-open
TOKEN=$(hc read dsh-host | grep -o 'token=[A-Za-z0-9_-]*' | cut -d= -f2)

# 5. turn + observe
node plugin/test/drive.mjs --token "$TOKEN" --base-url http://127.0.0.1:3181 \
  --state-file /tmp/herdr-e2e/evidence/agents.json --mode simple
hc get dsh-host --json

# cleanup (only the probe's own terminal)
hc kill dsh-host && hc rm dsh-host
```

Evidence files: `evidence/versions.txt`, `evidence/hc-get-idle.json`,
`evidence/state-document.sample.json`, `evidence/timeline-working-idle.jsonl`,
`evidence/timeline-blocked.jsonl`, `evidence/drive-simple.jsonl`,
`evidence/drive-blocked3.jsonl`.
