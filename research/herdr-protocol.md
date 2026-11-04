# Herdr OSC 7501 agent protocol — empirically verified spec (herdr-core 0.1.17 + herdr-app 0.1.17)

Status: authoritative for the DSH↔Herdr integration. Compiled 2026-11-04 by teammate
the DSH–Herdr integration project against the **installed** `hc 0.1.17` and
`herdr-app 0.1.17`, in an isolated core session, plus the pinned sources in
`/tmp/herdr-core-src` and `/tmp/herdr-app-src`.

Legend for every claim:

- **VERIFIED** — I ran a command and pasted/paraphrased its observed output; raw JSON is in
  `research/evidence/probe-core.json` and `research/evidence/probe-extras.json`.
- **SOURCE-INFERRED, not runtime-verified** — read from the Rust source / app manual only.
- **CONTEXT** — established by the integration brief, not re-run here.

Reproduce everything:

```sh
cd research/probes
# isolated session: its own core/socket/state, cannot touch your herdr-core or herdr-app
export HC_SESSION=proto1 XDG_STATE_HOME=/tmp/proto1/state XDG_CONFIG_HOME=/tmp/proto1/config \
       XDG_DATA_HOME=/tmp/proto1/data XDG_RUNTIME_DIR=/tmp/proto1/run
hc server start
python3 probe_core.py     # 93/93 cases pass (writes ../evidence/probe-core.json)
python3 probe_extras.py   # 4/4 probes pass  (writes ../evidence/probe-extras.json)
```

Probe programs: `emit_steps.py` (writes arbitrary bytes to its own pty, step by step, with
on-screen markers), `fake_dsh_agent.py` (a fake `app=dsh-tui` agent: interactive for templates,
`--auto` for the idle→working→blocked→done→idle demo).

---

## 1. Wire format (VERIFIED)

One status report is one OSC sequence written by the program to its terminal:

```
ESC ] 7501 ; pairs ST      report
ESC ] 7501 ; ? ST          feature-detection query (optional)
```

- `ESC` is `0x1b`, `ESC ]` is `0x1b 0x5d`. The final `ST` can be either `ESC \`
  (`0x1b 0x5c`) **or BEL** (`0x07`). Both were accepted:

  ```sh
  # emitter wrote ESC ] 7501 ; state=idle BEL
  hc get <t>  ->  {"status":{"state":"idle"},"records":{},"reported":true,"turn":0,...}
  # and ESC ] 7501 ; state=idle ESC \
  hc get <t>  ->  {"status":{"state":"idle"},...}
  ```
- `pairs := pair (":" pair)*`, `pair := key "=" value`. **Colon is the only separator.**
  Semicolon payloads, JSON payloads and bare words are rejected whole (no status, `reported:false`):

  | body sent | observed `hc get` |
  |---|---|
  | `state=working;app=dsh` | `status:null, reported:false` |
  | `{"state":"working"}` | `status:null, reported:false` |
  | `working` | `status:null, reported:false` |
- Pair rules: whitespace around keys and values is trimmed (` state = working :\tapp = cargo \t`
  → `{"state":"working","app":"cargo"}`); a pair with no `=` or an empty key is skipped and the
  rest of the report still applies (`junk:state=working` → working); a repeated key keeps the
  **last** value (`state=idle:app=a:state=done:app=b` → `{"state":"done","app":"b"}`); unknown
  keys are ignored (`state=idle:future=yes` → idle).
- Reports may be split across writes (parser continuation): `ESC]7501;state=wo` + `rking BEL`
  in two writes → `{"state":"working"}`. Text after a complete report is harmless.
  Two reports in one write are both applied in order.
- A complete `state=clear` root report with no records is valid (`reported:true`, `status:null`).

Value alphabet (important, see §3 caveats): keys and values are filtered by
`[A-Za-z0-9_.,+/=-]` before they are interpreted. Values with any byte outside that set are
treated as **absent** (the pair is skipped), not as an error.

## 2. Keys, values and validation (VERIFIED unless noted)

| key | accepted values | applied to | rejected/skipped when |
|---|---|---|---|
| `state` | `idle`, `working`, `done`, `blocked`, `error`, `clear` (lowercase, exact) | required; whole report discarded if missing/unknown | `sleeping`, `IDLE`, empty → whole report discarded |
| `id` | names joined by `/`: segments `[A-Za-z0-9_.+-]{1,32}`, ≤128 bytes total, ≤8 levels | child record key; empty/absent = root record | `a//b`, `/a`, `a/`, `a,b`, segment>32, >8 levels, total>128 → whole report discarded (**but see the 0.1.17 caveat in §3**) |
| `kind` | `permission`, `question`, `auth` | stored only with `state=blocked` | ignored for other states; unknown value (e.g. `dance`) reads as absent, report still applied |
| `progress` | decimal integer 0–100 | stored only with `working`/`blocked` | ignored for other states; `101`, `-1`, `4.5`, `256`, empty read as absent (report still applied); `007` → `7` |
| `app` | `[A-Za-z0-9_.+-]{1,32}` | stored verbatim in `status.app` on the record | value with space `/` `=` or >32 bytes is skipped (no `app`), report still applied (exception: >32-byte value discards the report, §3) |
| `title` | **base64 of UTF-8**, decoded length ≤192 bytes, encoded length ≤256 | `status.title`, decoded plain text | see §3: plain text without `?` etc. **is** treated as base64 attempt; invalid base64/control chars discard the report |
| `msg` | **base64 of UTF-8**, decoded length ≤2048 bytes, encoded length ≤2732 | `status.msg`, decoded plain text | same as title |

Evidence excerpts (`hc get <t>`, exact JSON fragments):

```
state=blocked:kind=permission            -> {"status":{"kind":"permission","state":"blocked"},"reported":true}
state=working:progress=42                -> {"status":{"progress":42,"state":"working"},"reported":true}
state=idle:app=dsh-tui                   -> {"status":{"app":"dsh-tui","state":"idle"},"reported":true}
state=idle:title=SGVsbG8=                -> {"status":{"state":"idle","title":"Hello"},"reported":true}
state=blocked:msg=QXBwcm92ZT8=           -> {"status":{"msg":"Approve?","state":"blocked"},"reported":true}
state=done:msg=hello                     -> {"status":null,"records":{},"reported":false}   # invalid padding/length => whole report discarded
state=idle:title=SGVsbG8=:msg=...        # 192-byte decoded title accepted; 193-byte discarded
                                         # 2048-byte decoded msg accepted; 2049-byte discarded
```

IDs / multiple records (root record = `status`, child records = `records` map):

```
state=working:id=build              -> {"status":null,"records":{"build":{"state":"working"}}}
state=blocked:id=build/test:app=child -> {"records":{"build/test":{"state":"blocked","app":"child"}}}
                                     # a parent does not have to exist
state=clear:id=build                # removes build and build/test, keeps buildx and deploy
state=clear                          # removes the root record and every child record
```

Record cap (**VERIFIED**, and it differs from the published spec text): after reporting
`r000`…`r255` and then `r999`, `hc get` showed **255** child records, with `r000` and `r001`
evicted and the newest kept. `status.rs` evicts `records.keys().next()` (BTreeMap-first, **not**
LRU) once `records.len() >= MAX_RECORDS-1` with `MAX_RECORDS=256`, so the effective steady state
is 255 records/terminal.

`turn`/`status_ms`/`reported` (root record only):

- `turn` goes up **each time the root record leaves `working`**, for any reason:
  `working→done`, `working→idle`, `working→blocked`, `working→error`, `working→clear` all gave
  `turn=1`; `idle→done`, `blocked→done`, `working→working` gave `turn=0`; child records never
  move it (`working:id=build` + `done:id=build` leaves `turn=0`). (VERIFIED)
- `status_ms` changes **only when the root word changes**: same word again and child-record
  reports leave it untouched (VERIFIED; steps 0/1/2 `working` all `status_ms=1793792510569`,
  then `idle` → `1793792512369`).
- `reported` is sticky `true` once any report was accepted; it stays `true` after `clear` and
  after process exit. `state=clear` after `working` → `{"status":null,"records":{},"reported":true,"turn":1,"status_ms":<new>}` (VERIFIED).
- Program exit resets status facts: finished terminal shows
  `{"state":"finished","status":null,"records":null,"reported":true,"turn":1,"status_ms":...,"exit_code":0}`
  (VERIFIED; `records` serialises as `null` for finished records via `hc get`).

## 3. 0.1.17 parser caveats — differences from the upstream spec (VERIFIED; check before relying on them)

`herdr-core 0.1.17` is built against Ghostty commit `1e5cdb86` (pinned in the source checkout's
`vendor/ghostty` submodule; the checkout's git tree records it). The C parser of that commit
treats values **outside** the value alphabet differently from current upstream `master`, and
this matters for integration:

1. **title/msg containing a byte outside the base64 alphabet are silently dropped, not fatal.**
   The whole report still applies without that text. E.g. `state=blocked:msg=Approve?` →
   `{"status":{"state":"blocked"}}`, `reported:true` (the `?` is not in the alphabet, the pair is
   skipped). Contrast `state=done:msg=hello`, whose chars are all legal base64-alphabet bytes but
   which is not valid base64 → **whole report discarded** (`status:null, reported:false`).
   Consequence: always emit strict standard base64 for `title`/`msg`; plain text may either
   vanish silently (`Approve?`) or kill the whole report (`hello`/`Plan`).
2. **An `id` with a byte outside the value alphabet is dropped as a pair, so the report hits the
   ROOT record.** `state=idle:id=a@b` → `{"status":{"state":"idle"},"records":{}}`, `reported:true`.
   Same for `id=a b`. This is a real fallback-to-root bug for 0.1.17: keep ids to
   `[A-Za-z0-9_.+-]` segments joined by single slashes. (Ids containing in-alphabet but invalid
   characters like `,` are still fatal: `id=a,b` → whole report discarded.)
3. **`id=` (empty id) discards the whole report** (`{"status":null,"reported":false}`), it does
   not mean "root". Omit `id` entirely for the root record.
4. **`state=clear:id=<invalid>` never falls back to the root**: `clear:id=a//b` retained both the
   root `{"state":"working","app":"dsh"}` and `records{"build":...}` (VERIFIED). Good: a malformed
   clear cannot wipe everything.
5. Hard limits (all VERIFIED at the boundary): the body, i.e. the bytes after `7501;`, max
   **4087 bytes** — a 4087-byte body was accepted, 4088 rejected (the parser's `max_body_bytes`
   for the longer `ESC \\` terminator; the whole sequence cap in the spec is 4096). Key ≤16 bytes (17 → whole report discarded, even unknown keys). `app` ≤32 (33 →
   discarded). title ≤256 encoded / ≤192 decoded. msg ≤2732 encoded / ≤2048 decoded. id ≤128
   total / ≤32 per segment / ≤8 levels. 255 child records steady state (§2).
6. Unknown keys are ignored, but any pair key longer than 16 bytes discards the report.

## 4. Feature detection: `OSC 7501 ; ?` (VERIFIED)

The installed core **does** answer, with the same terminator the query used, and only writes the
reply when the program reads its stdin in raw mode (a canonical-mode pty buffers input without a
newline — this delayed my first negative test, so do not conclude "no reply" from a cooked tty):

```sh
# program: tty.setraw(0); write ESC ] 7501 ; ? BEL ; select() on stdin
hc read --lines 0 <t>
# QUERY-REPLY:1b5d373530313b3f3a7374617465733d69646c652c776f726b696e672c646f6e652c626c6f636b65642c6572726f723a6b696e64733d7065726d697373696f6e2c7175657374696f6e2c6175746807
# decoded: ESC ] 7501 ; ?:states=idle,working,done,blocked,error:kinds=permission,question,auth BEL
```

A program that cannot read replies may skip detection (the spec allows it; reports work without
it). DSH should not block on a reply.

## 5. What the app does with the words — DONE vs IDLE

SOURCE-INFERRED, not runtime-verified against your live app (its core is the
user's; I did not disturb it). Source: `/tmp/herdr-app-src/src/model.rs`,
`src/window.rs`, `src/sound.rs`, `defaults/mods/agents/main.js`, and the app's own manual
`~/.config/herdr-app/AGENTS.md` (§Agents, §Programs, §The person).

Core stores words as reported; the app computes the UI status (confirmed by the project in
integration brief and re-read in source):

```rust
// model.rs: what the UI shows: working, blocked, done (finished, unseen), idle, or None
Some(match a.word.as_deref()? {
    "working" => "working",
    "blocked" | "error" => "blocked",
    _ if a.seen_turn.map_or(!a.seen, |s| a.turn > s) => "done",
    _ => "idle",
})
```

- `working` shows as **Working**; `blocked` and **`error` both show as "blocked"/needs-you**.
- `done` **and `idle`** both show as **Done** while the person has not looked since the last
  turn ended; once they look (or the shared `herdr.seen` turn label catches up), they become
  **Idle**. So "done vs idle" is a *seen* distinction, not a different wire word — but the
  recommended reporting split remains: `done` = finished work awaiting review, `idle` = at rest.
- The turn counter that drives this is core's `turn` (§2) and the label `herdr.seen`; a
  `done`/`idle` after `working` while the user isn't looking is shown as Done and can alert.
- Alert rules (`model.rs::alert`): new word `blocked`/`error` when the previous word wasn't
  → **"needs you"** alert; previous word busy (`working`/`blocked`/`error`) and new word not
  busy and the person isn't looking → **"finished"** alert. Alerts: bundled/custom MP3 sound
  (`settings.json` `sounds.enabled`, `.done`, `.blocked`; `HERDR_APP_NO_SOUND` disables) and a
  toast (`{name} needs you` / `{name} finished`), unless looking; a blocked agent also brings a
  settled tab back. Sub-agent terminals (`parent` set) and terminals in no Herdr pane do not
  ring (`alert_for`).
- Agent list (`defaults/mods/agents`): sections **Needs you (blocked) > Done > Working > Idle**
  (`RANK = {blocked:4, done:3, working:2, idle:1}`), priority sort, pinned first, sub-agents
  nested under their parent. A space's/tab's status is the most urgent of its agents
  (`blocked > done > working > idle`; app manual + `model.rs::rollup`). A viewed Done agent
  stays in Done until you leave it (`hold()`).

> For DSH: report `working` while a turn runs, `blocked` + `kind` when waiting on the user
> (`permission` for approvals, `question`/`auth` as applicable), `error` on failure, and
> `done`/`idle` when the turn ends. Do not try to manage "unseen" yourself — the app does it.

## 6. Program/name/icon resolution for `app="dsh"` / `app="dsh-tui"`

SOURCE-INFERRED from `/tmp/herdr-app-src/src/programs.rs`, `defaults/programs.json`,
`~/.config/herdr-app/AGENTS.md` §Programs; app CLI shape VERIFIED read-only via `herdr-app ls`.

How a terminal's `program` is chosen (`programs.rs::resolve(app, argv)`):

1. If the terminal's **latest root 7501 report has a non-empty `app`**, that app is looked up in
   the program table: exact key first, then any entry's `match`/alias list (case-insensitive).
   - **Found** → that entry's `name`/`icon`/`tint`/`tile`/`color`, `agent:true`.
   - **Not found** → key `"agent"`: the display name is the raw app string, icon
     `icons/agent.svg` (generic "Agent"), `agent:true`.
2. No `app`: unwrap the app's shell wrapper and interpreters, then match the running program's
   basename against keys/`match`; shells → `shell`; unknown → `program` with a hashed tile color.
3. `programs.json` entries are layered **over** the built-in table entry by entry
   (`name`/`icon`/`tint`/`tile`/`color` per field; a non-empty `match` replaces the built-in
   list; `run` replaces). The file is `~/.config/herdr-app/programs.json`; an invalid file
   surfaces in `programs.error`; reload is live (mtime checked on the app's poll), and the
   shipped icons are (re)written to `~/.config/herdr-app/icons/`.

The **built-in table already has** (verified by reading `defaults/programs.json`; the app was
also installed from this source):

```json
"dsh-tui": {"name":"DeepSeek Harness","icon":"icons/dsh-tui.svg","run":["dsh-tui"],
            "tint":true,"tile":"#1c1d21","color":"#ffffff"}
```

`herdr-app ls` (read-only VERIFIED) shows the shape mods consume per terminal — word + raw app:

```json
{"terminal":"t5","pane":"...","status":"idle","app":"pi","name":null,"sub_agents":[]}
```

**Conclusion: report `app=dsh-tui` and the user needs to add nothing** — Herdr shows
"DeepSeek Harness" with the shipped DeepSeek icon. Reporting `app=dsh` shows a generic
"Agent" icon named literally `dsh` unless the user adds an entry to
`~/.config/herdr-app/programs.json`, e.g.:

```json
{ "programs": { "dsh": { "name": "DeepSeek Harness", "icon": "icons/dsh-tui.svg",
                         "tint": true, "tile": "#1c1d21", "color": "#ffffff" } } }
```

(`app` values are also matched through `match` lists; `dsh` could alternatively be added to the
built-in `dsh-tui` entry's `match` list by the user, via the same file:
`{"programs":{"dsh-tui":{"match":["dsh"]}}}` — `match` replaces the list, so include `dsh-tui`'s
existing aliases if any.)

## 7. CLI verification recipes (VERIFIED)

Isolate first — never point these at your core:

```sh
export HC_SESSION=proto1 XDG_STATE_HOME=/tmp/proto1/state XDG_CONFIG_HOME=/tmp/proto1/config \
       XDG_DATA_HOME=/tmp/proto1/data XDG_RUNTIME_DIR=/tmp/proto1/run
hc server start
```

Launch a program that reports and hold the terminal:

```sh
hc run --bg --name probe -- python3 research/probes/emit_steps.py /tmp/steps.json
# or a shell one-liner:
hc run --bg --name probe -- bash -c "printf '\033]7501;state=working:app=dsh-tui\007'; sleep 300"
```

Assert fields (JSON is the default when piped; `--json` forces it in a tty):

```sh
hc get --json probe | jq -c '{status,records,reported,turn,status_ms,state}'
# {"status":{"app":"dsh-tui","state":"working"},"records":{},"reported":true,"turn":0,
#  "status_ms":1793792503438,"state":"live"}
```

`hc get` fields that matter (all VERIFIED present):

| field | meaning |
|---|---|
| `status` | root record: `{state, kind?, progress?, app?, title?, msg?}` — absent keys mean "not reported"; `null` = no root record |
| `records` | map `id -> {state, kind?, progress?, app?, title?, msg?}` (omitted when empty; `null` for finished terminals) |
| `reported` | true once the terminal ever sent an accepted report (sticky through clear/exit) |
| `turn` | increments when the root record leaves `working` |
| `status_ms` | epoch ms of the last root-word change (null if never reported) |
| `state` | `live` / `finished` |

Other commands used in tests:

```sh
hc ls                      # all live terminals (--all: finished too)
hc read --lines 0 probe    # visible screen text ("--lines 0" = screen only)
hc events --terminal probe # see §8
hc wait --json probe       # see §8
hc kill probe / hc rm probe
```

## 8. `hc events`, `hc wait` (VERIFIED)

`hc events` (piped): first a plain snapshot line, then JSON-RPC envelopes:

```json
{"channel":null,"seq":3944,"terminals":[{"address":"t17b", ... ,"status":{"state":"idle",...},"turn":0}]}
{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"dsh-tui","kind":"permission","msg":"Approve? run: rm -rf build","state":"blocked","title":"DSH · main"}},"seq":3946,"terminal":"t17b","type":"status"}}
{"jsonrpc":"2.0","method":"event","params":{"data":{"state":"blocked","turn":1},"seq":3947,"terminal":"t17b","type":"turn"}}
```

Observed event types for one working→blocked→done→idle run: `status`, `turn`. `status.data` =
`{status, records, reported}`; `turn.data` = `{turn, state}`. Filters: `--terminal`, `--children-of`,
`--label K=V`. Subscribe **before** driving transitions if you must not miss one.

`hc wait` (VERIFIED; blocks until the terminal stops working, then returns JSON):

```sh
start=$(date +%s); hc wait --json t17c; echo "waited $(( $(date +%s) - start ))s"
# {"children":[],"ended":true,"exit_code":null,"reason":"status","signal":null,"status":"idle","terminal":"t17c","turn":1}
# waited ~1.2s (the program reported working, then idle 1.2s later)
```

Use `hc wait --output TEXT` for non-agent programs, `--timeout SECONDS` to bound it,
`hc wait --children all` for sub-agents. For tests prefer `hc wait` + polling `hc get` over
`sleep`.

## 9. Templates: readiness waits for the FIRST OSC 7501 report (VERIFIED)

Format: `~/.config/herdr-core/templates/<name>.md` (or under `$XDG_CONFIG_HOME`), frontmatter
between `---` lines, fields `command` (required), `description`, `ready` (default: wait for an
OSC 7501 report; `quiet` = wait for output to settle), `submit`, `stop`, `paste_gap_ms`; the
body is prepended to the task (`body + "\n\n" + task`), the command runs through `sh`.

Verified with `fake_dsh_agent.py` (reports `state=idle:app=dsh-tui` first, then reads stdin):

```sh
hc templates
# {"templates":[{"name":"fake-dsh","description":"...","command":"python3 .../fake_dsh_agent.py"}, ...]}
hc run --bg --name tpl --json fake-dsh "add a README"
# {"address":"t17k","agent":"sh","first_message":{"sent":true,"started":true,"turn":0},
#  "name":"tpl","state":"live","template":"fake-dsh","turn":0}
```

Observed sequence: the task text arrived on the agent's stdin (screen showed the template body
then the task), the agent reported `working`, then `blocked/kind=permission`, and a later
`hc send --force tpl yes` produced `working` → `done` → `idle` (exact `hc get` JSON in
`evidence/probe-extras.json`, `templates.observed`).

A **headless one-shot cannot be a template agent**: a program that reports `done` and exits
satisfies readiness by exiting, but there is nobody to receive the task:

```sh
hc run --bg --name oneshot --json oneshot "task"
# {"address":"t17m",...,"first_message":{"reason":"t17m has finished","sent":false},...}
# hc get t17m -> {"state":"finished","status":null,"reported":true,"turn":0,...}
```

Readiness timeout default is 30 s (templates docs); on timeout the first message is not sent and
`first_message: {sent:false, reason}` stays on `hc get` for recovery. Programs that only report
after receiving a task deadlock the default `ready`; report an early `idle` (as a TUI would), or
use `ready: quiet` for programs that don't speak 7501 (quiet gives no agent status).

## 10. End-to-end evidence: fake `dsh-tui` agent (VERIFIED)

`python3 probes/fake_dsh_agent.py --auto` in `hc run --bg`, capturing `hc get` after each
on-screen marker (full JSON in `evidence/probe-core.json`, `additional[id=e2e-fake-dsh-agent]`):

| step | report | `hc get` excerpt |
|---|---|---|
| A | `state=idle:app=dsh-tui:title=RFNIIM t...` (`DSH · main`) `:msg=...` | `{"status":{"app":"dsh-tui","msg":"waiting for a task","state":"idle","title":"DSH · main"},"reported":true,"turn":0}` |
| B | `state=working:app=dsh-tui:...` | `{"status":{"app":"dsh-tui","msg":"running a turn","state":"working","title":"DSH · main"},"reported":true,"turn":0}` |
| C | `state=blocked:kind=permission:app=dsh-tui:...` | `{"status":{"app":"dsh-tui","kind":"permission","msg":"Approve? run: rm -rf build","state":"blocked","title":"DSH · main"},"reported":true,"turn":1}` |
| D | `state=done:app=dsh-tui:...` | `{"status":{"app":"dsh-tui","msg":"turn finished: 3 edits","state":"done",...},"turn":1}` |
| E | `state=idle:app=dsh-tui:...` | `{"status":{"app":"dsh-tui","msg":"ready for the next task","state":"idle",...},"turn":1}` |

The exact raw reports (title/msg shown decoded; they were base64 on the wire) are in
`probes/fake_dsh_agent.py`. This is the reference pattern a DSH integration should copy.

## 11. Integration rules for DSH (derived from the above; all enforceable)

1. **Only report inside a Herdr-managed terminal.** herdr-core injects
   `HC_TERMINAL_ID`/`HC_TERMINAL_SOCKET`/`HC_SESSION`/`HC_SCOPE` into programs it starts; gate
   the emitter on presence of `HC_TERMINAL_ID` or `HC_TERMINAL_SOCKET` (documented; re-verify in the
   DSH plugin task). Outside Herdr the bytes would just be terminal noise.
2. **Always** `app=dsh-tui` (first choice; built-in name+icon) with `state` last-write-wins;
   emit on every change, not on a timer (no heartbeat required or wanted).
3. Encoders, exactly:
   - body `state=<word>` + optional `:app=dsh-tui` + optional `:kind=permission|question|auth`
     only with `blocked` + optional `:progress=0..100` only with `working`/`blocked` +
     optional `:title=<base64>` + optional `:msg=<base64>`; terminate with BEL.
   - base64 = RFC 4648 standard alphabet with `=` padding, UTF-8 source; keep title ≤192 and
     msg ≤2048 **decoded** bytes (longer silently kills or corrupts reports); strip newlines —
     controls are rejected.
   - never send an `id` containing anything but `[A-Za-z0-9_.+-]` segments joined by single
     `/` (0.1.17 bug: it would fall back to the root record). For one session the root record is
     enough; use ids only for parallel sub-tasks (`dsh/<session>` etc., ≤32 per segment).
   - no unknown/extended keys needed; anything >16-byte keys is fatal.
4. State mapping: turn start → `working` (progress optional); any time the turn needs a human →
   `blocked` with `kind` (`permission` for tool approval, `question` for a question, `auth` for
   auth) plus a one-line `msg` that says what is needed; turn done → `done` (work to review) or
   `idle` (ready; the app shows both as Done-until-seen); fatal failure → `error`; on shutdown /
   session cleared → `state=clear` (or just exit — exit resets status but keeps `reported`).
5. `title` is a human label (e.g. DSH session name); `msg` is the one-line activity. Both are
   untrusted text in the app; no markup, no control chars. Include the session so multi-session
   DSH is distinguishable (sidebar shows the program icon + title/name).
6. `hc get --json <t>` is the contract test: assert `status.state`, `status.app=="dsh-tui"`,
   `reported==true`, `turn` increments on turn end, and `status.kind` on approvals. Use
   `hc wait --json <t>` to observe the working→not-working transition.

## 12. Known unknowns / not verified at runtime

- App-side rendering (§5, §6) is source+manual inferred; your live app/core were not
  touched. A demo-space test in the integration task should confirm: "DeepSeek Harness" name,
  icon, Needs-you/Done sections, sound+toast, `herdr-app ls` showing `status`/`app`.
- `hc get` on a **finished** terminal observed `records: null` (not `{}`); treat as
  "not meaningful after exit".
- The app's built-in program table also includes `dsh-tui` — verified in
  `/tmp/herdr-app-src/defaults/programs.json` and asserted by that crate's own tests
  (`programs.rs` test: `key(Some("dsh-tui")) == "dsh-tui"`), but not re-verified through the
  running app's `ls` because no `dsh-tui` process is running there.
- The exact OSC capture limit interacts with the terminal emulator's own maximum; 4087-byte
  body accepted / 4088 rejected is what the installed core does, not necessarily a contractual
  stable number in future versions.
- `hc events` sequence numbers/`channel` are core-internal; assert on `type`/`terminal`/`data`.

## 13. Evidence index

| file | contents |
|---|---|
| `research/evidence/probe-core.json` | 93 cases: wire/validation matrix, limits, ids/clear, records cap, turn/status_ms semantics, reported/reset, full e2e `hc get` JSON per step |
| `research/evidence/probe-extras.json` | `hc events` sample/event types, `hc wait` output+timing, feature-detection query reply bytes, template readiness (interactive + one-shot), screens |
| `research/evidence/herdr-app-ls.json`, `herdr-app-status.json` | read-only live app listing (shape of `status`/`app`/`sub_agents`; app's own program resolution is not a CLI surface) |
| `research/probes/probe_core.py` | the matrix runner (isolated session; PASS/FAIL printed) |
| `research/probes/probe_extras.py` | events/wait/query/templates runner |
| `research/probes/emit_steps.py` | raw-byte emitter with markers (deterministic sync) |
| `research/probes/fake_dsh_agent.py` | reference fake `dsh-tui` agent (`--auto` and template- interactive modes) |
| `/tmp/herdr-core-src/crates/herdr-core/src/status.rs` | record/turn/clear logic (source) |
| `/tmp/herdr-core-src/crates/ghostty-vt/src/lib.rs`, pinned Ghostty `src/terminal/osc/parsers/program_status.zig` (commit `1e5cdb86`) | parser/limits/validation (source) |
| `https://www.superlogical.com/rex/docs/build/program-status` | the Program Status Protocol spec (revision 0.4, 2026-10-10) that Ghostty implements |
