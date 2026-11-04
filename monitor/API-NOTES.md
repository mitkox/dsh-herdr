# DSH ↔ Herdr monitor: API / data-source notes

Verified 2026-11-04 against your live environment (read-only) and the
installed DSH `0.2.2-rc.1` (`/path/to/dsh/`,
process cmdline: `.../@deepseek-ai/dsh/lib/bin.js web`, listening `127.0.0.1:3080`).

Two possible data sources for a monitor:

1. the DSH **host HTTP API** — needs the launch token, not available to a
   sidecar process started elsewhere (details below);
2. the **session journal on disk** — append-only, no auth, read-only. This is
   what `dsh-watch.mjs` / `dsh-herdr.mjs` use and what this document specifies.

The third source, a **host plugin** (teammate `dsh-plugin`), gets in-process
events and needs a profile change + host restart. See README feasibility.

---

## 1. Host HTTP API (DSH 0.2.2-rc.1) — why a sidecar cannot use it

### 1.1 Auth fence

`dsh-web-app` prints and opens `http://127.0.0.1:<port>/?token=<random>` at
launch. The token is exchanged **only** at the root (`GET /?token=...`), which
writes an authority-bound signed HttpOnly cookie and redirects; `/api/*` then
requires that cookie. There is no Authorization-header token and no loopback
bypass for `/api`.

Observed (live host, unauthenticated):

```console
$ curl -s -X POST http://127.0.0.1:3080/api/session.list \
    -H 'content-type: application/json' \
    -d '{"type":"client-request","rpcId":"p1","method":"session.list","payload":{}}'
HTTP 401 — unauthorized

$ curl -s http://127.0.0.1:3080/api/events.mux
HTTP 401 — unauthorized

$ curl -s 'http://127.0.0.1:3080/?token=<stale token from ~/.dsh/web.log>'
HTTP 401 — "dsh web authentication required; reopen the URL printed by dsh web."
```

The current launch token is printed to the host's own stdout (your
terminal), not logged to `~/.dsh/web.log` (that log is stale: it contains a
token for a previous launch). Source of truth:
`packages/client/connection/README.md` §"Browser authentication and request
trust" (dev checkout) — token only at `GET /`; API callers instead use
`GET /connect?token=...&interactions=none`, which returns `302` with a signed
API cookie; a WebSocket then speaks for that API Peer. For a monitor to use the
API it would have to read the token out of the host's terminal/stdout, which is
not a supportable integration. **Decision: the sidecar uses the journal.**

### 1.2 Unary RPC (for completeness)

The Connection RPC envelope survived the API rewrite: a unary call is
`POST /api/<endpoint>` with

```json
{ "type": "client-request", "rpcId": "rpc-...", "method": "<endpoint>", "payload": { "args": { } } }
```

and answers `{ "type": "server-response", "rpcId": ..., "result": { "ok": true, "value": ... } }`
(errors: `result: { ok: false, error: { code, message, details } }`). Endpoint
names are the generated Typert endpoints, slash-namespaced:
`session/list`, `session/create`, `session/prompt`, `session/history`→`session/page`,
`session/follow` (stream), `session/wait`, `session/cancel`,
`session/observeState` (stream), `skills/list`, … (full list extracted from
`@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js`).

### 1.3 Streaming

- Mux/stream channel: **WebSocket `/api/remote.mux`** (shared by all logical
  streams). Frames are JSON text: client→host `{type:'open', streamId, endpoint, payload}`,
  `{type:'item', streamId, value}`, `{type:'end'|'cancel', streamId}`; host→client
  `{type:'item', streamId, value}`, `{type:'end', streamId}`,
  `{type:'error', streamId, error:{code,message,details}}`
  (`packages/api/gateway/src/stream-protocol.ts`, exported as
  `@deepseek-ai/dsh-api-gateway/stream-protocol`).
- The old **SSE `/api/events.mux` no longer exists** in 0.2.2-rc.1: the
  installed package tree contains no `events.mux` string, the dev checkout's
  `docs/subsystems/web-client.md` states there is no monolithic `events.mux`
  API, and the only mux path in source is `/api/remote.mux`. Awaiting the auth
  cookie, any probe of `/api/events.mux` dies at the 401 fence.

### 1.4 Consequence for the third-party `dsh-tui` (v0.2.19, MIT)

`/tmp/dsh-tui-pkg/package` is an old-API client: dotted methods
(`session.list`, `session.create`, `session.prompt`, `session.history`,
`session.cancel`, `subagent.list`), SSE `GET /api/events.mux` for live frames,
and `POST /api/respond` for approvals/questions. It has no auth-cookie flow.
Empirically against the live 0.2.2-rc.1 host:

```console
$ DSH_URL=http://127.0.0.1:3080 node bin/tui.js < /dev/null
dsh-tui: HTTP 401 from session.list
$ DSH_URL=http://127.0.0.1:3080 node bin/tui.js run "say hi"
dsh-tui: HTTP 401 from session.create
```

(These calls are rejected at the fence, before any host handler runs: nothing
was created or mutated.) Even with a cookie, its endpoint names (`session.list`)
do not match the new `/`-namespaced routes, and its live stream path is gone.
**Running the real `dsh-tui` in a pane + a sidecar reporter is not viable on
the current host without a compat shim or pinning an old DSH release.**

---

## 2. Session journal on disk (the source the sidecar uses)

### 2.1 Location and encoding

```
$DSH_HOME/sessions/<cwd-slug>/<session-dir>/session.v4.jsonl.zstd
$DSH_HOME/sessions/<cwd-slug>/<session-dir>/session.lock        (0 bytes)
```

- `$DSH_HOME` defaults to `~/.dsh`; `DSH_HOME` is present in tool/child env
  (`DSH_HOME=/home/you/.dsh`, `DSH_PROFILE=web`).
- The journal is **JSONL compressed as a concatenation of zstd frames** — one
  frame per append. Verified on a live journal: `zstd --list -v` reports
  `# Zstandard Frames: 146` for an ~890 KiB decompressed file.
- This makes a **truncated trailing frame normal** while the host writes.
  Decode tolerantly: take the decodable prefix (Node's streaming
  `zlib.createZstdDecompress` emits it before `unexpected end of file`), then
  process only `\n`-complete JSON lines. Full-file decode is fine: ~890 KiB in
  ~2 ms; poll only when size/mtime changed.
- Node 26 has `zlib.zstdDecompressSync` / `createZstdDecompress`; the `zstd`
  binary (`/usr/bin/zstd` 1.5.7) is a fallback only.

### 2.2 Record shapes

First line is the session header:

```json
{"type":"session","version":4,"id":"<session-uuid>","createdAt":1793792023245,
 "cwd":"/home/you/src/acme-app","parentSession":null,
 "origin":"subagent","agentPreset":"standard"}
```

Every following line is one folded session event:

```json
{"type":"tool/call","seq":19,"time":1793792024918,
 "data":{"turn":1,"step":1,"callId":"call_00_...","name":"read","arguments":"{\"file_path\":\"...\"}"}}
```

`time` is epoch milliseconds; `seq` strictly increases per session.

### 2.3 Event types seen in real journals (40 live journals scanned)

`turn/start`, `turn/end`, `step/start`, `step/end`, `tool/call`, `tool/result`,
`assistant/message`, `user/message`, `system/message`, `developer/message`,
`session/title`, `session/title-llm-request`, `request/header`, `request/context`,
`todo/write`, `job/registered`, `job/settled`, `team/task`, `team/member`,
`agent/inbox/spliced`, `command/run`, `command/done`, `subagent/descriptor`,
`subagent/catalog`, `model/selection`, `permission/preset`, `sandbox/mode`,
`approval/policy`, `assistant/attempt`, `llm/retry`, `workspace/changes`, …
(Full catalogue: dev checkout `docs/persistence-catalog.md`.)

Shapes the monitor relies on:

| Event | data used |
|---|---|
| `turn/start` / `turn/end` | `data.turn`, `data.reason` (`{kind:'done'|'error'|...}`) |
| `tool/call` | `data.callId`, `data.name`, `data.arguments` (JSON string) |
| `tool/result` | `data.message.toolCallId` (or `data.message.source.callId`); failure in `data.error` / `data.message.error` |
| `assistant/message` | `data.message.content[]` text blocks |
| `user/message` | `data.content[]` text blocks |
| `session/title` | `data.title` — the session title **is journaled** |
| `approval/asked` | `data.id`, `data.toolName`, `data.callId?`, `data.reason?` |
| `approval/decided` | `data.id`, `data.outcome` (`allowed-once`/`rejected`/`cancelled`/`unavailable`) |

### 2.4 Turn start/end and "working" state

`working` = the last `turn/start` has no later `turn/end`. Turn state is
per-session and derived by folding the whole journal from the header onward
(the sidecar keeps a running fold while tailing). A journal that stops growing
mid-turn (host crash) is reported `idle` with a `stale:` activity after a
cutoff (`--stale-ms`, default 15 min) so a dead host cannot leave a Herdr agent
"working" forever.

### 2.5 Blocked detection — approvals vs questions (finding)

- **Approvals ARE journaled**: `approval/asked` is appended when the approval
  request is put to the answerer chain, and `approval/decided` when the outcome
  is known (persistence catalog: both are *log-only audit* events, explicitly
  persisted; verified in `packages/interaction/user-approval/src/index.ts:225`).
  A pending approval = an `approval/asked` `id` with no matching
  `approval/decided`. This gives `state=blocked:kind=permission` with
  `msg=approval: <toolName>`.
- **User questions are NOT journaled as their own events.** There is no
  `question/*` persisted event type (catalogue scan) — the question is a live
  transient request; only the eventual answer is visible (as a
  `user-question-reply` attribution on the tool result / followed by a
  `user/message`). Detect them structurally: a pending `tool/call` whose
  `name` is `ask_user_question` (the question tool) or `exit_plan_mode`
  (plan-review question through `ctx.userQuestions.ask`) with no matching
  `tool/result` ⇒ `state=blocked:kind=question`, msg from the parsed
  `arguments.questions[0].question`.
- Caveats: a policy that auto-answers approvals journals the ask+decide pair
  with a near-zero pending window (monitor may never observe `blocked`); a
  *timed* `ask_user_question` can return `pending` while still answerable
  (it is then "continued" and not blocking the turn) — the journal sees the
  tool result, so a continued question is not reported blocked. Both matches
  your semantics, and both are documented rather than hidden.
- The synthetic test proves the mechanisms end-to-end (see TESTING.md); no live
  approval/question occurred in the scanned journals while testing, so the
  live-observed blocked case is still synthetic-only.

### 2.6 Risks / limits

- The journal format is internal and versioned (`session.v4.jsonl.zstd`,
  header `version:4`); it is not a documented public API and may change.
- Full-file decode per change is O(n) in journal size; fine for the observed
  <1 MiB journals (2 ms). Very long sessions (tens of MiB) would need frame-
  boundary incremental decoding — not implemented.
- The journal is written by the host, so monitor lag is bounded by the host's
  append flushing + the poll interval (observed < 1 s end-to-end; the project
  measured same-second appends).

---

## 3. OSC 7501 reporting (verified empirically, isolated herdr-core 0.1.17)

Wire: `ESC ] 7501 ; key=value(:key=value)* ESC \` (BEL also accepted).
Fields: `state`, `kind`, `progress`, `id`, `app`, `title`, `msg`.

Verified in `HC_SESSION=probe4` (scratch XDG dirs, own core):

```console
$ printf '\033]7501;state=working:app=dsh-tui:title=Plain Title:msg=doing a thing\033\\'
$ hc get oscplain → "status":{"app":"dsh-tui","state":"working"}        # title/msg DROPPED
$ printf '\033]7501;state=working:app=dsh-tui:title=UGxhaW4gVGl0bGU=:msg=ZG9pbmcgYSB0aGluZw==\033\\'
$ hc get oscb64   → "status":{"app":"dsh-tui","msg":"doing a thing",
                              "state":"working","title":"Plain Title"}  # base64 decoded
```

Rules the monitor uses:

- `title` and `msg` **must be base64**; non-base64 values are silently dropped
  by the parser (they are decoded on input, re-encoded on `Status::encode`).
- `state` ∈ `idle | working | done | blocked | error | clear`; the monitor
  emits `working | blocked | idle` (and `clear` on clean exit).
- `kind` is only valid with `blocked`: `permission | question | auth`.
- `app=dsh-tui` so herdr-app's built-in "DeepSeek Harness" program entry
  (name + shipped DeepSeek icon) applies. Plain `title`/`msg` values are
  sanitized (control chars, length-clipped) before base64.
- OSC is written to the monitor program's stdout (its pane PTY). Only enable
  when it owns a terminal: `HC_TERMINAL_ID`/`HC_TERMINAL_SOCKET` present AND
  `process.stdout.isTTY`. DSH tool children inherit those env vars (the host
  runs in pane `t2`) with piped stdout — auto-enabling there would print OSC
  bytes as text. `--osc` forces it for tests.
- herdr-core increments the terminal's turn counter whenever the root record
  leaves `working`; the app's agent list/urgency then sees idle/working/
  blocked without any client-side polling.
