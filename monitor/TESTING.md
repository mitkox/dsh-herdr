# dsh-watch / dsh-herdr — test evidence

All tests were run **without touching your live DSH web host
(:3080), their herdr-core (default session) or their herdr-app**. Herdr tests
used an **isolated herdr-core session** with scratch XDG dirs:

```sh
export HC_SESSION=probe4 \
  XDG_STATE_HOME=/tmp/probe4/state XDG_CONFIG_HOME=/tmp/probe4/config \
  XDG_DATA_HOME=/tmp/probe4/data XDG_RUNTIME_DIR=/tmp/probe4/run
hc server start          # isolated core, own socket under /tmp/probe4/run
```

Nothing was installed globally; all files live in `/tmp/probe4` or this
directory. `dsh-tui` deps were installed **only** into its unpacked /tmp copy
(not globally, not on PATH) for the incompatibility probe in §4.

---

## 1. Deterministic synthetic test — OSC 7501 transitions (isolated hc core)

The journal format is produced by `tests/make-session.mjs` (header + one zstd
frame per appended JSONL event — identical to how the host appends). Then
`dsh-herdr` runs **inside an isolated herdr-core terminal** and we read its
reported status with `hc get` at each stage.

Reproduce:

```sh
export HC_SESSION=probe4 XDG_STATE_HOME=/tmp/probe4/state \
  XDG_CONFIG_HOME=/tmp/probe4/config XDG_DATA_HOME=/tmp/probe4/data \
  XDG_RUNTIME_DIR=/tmp/probe4/run
hc server start
cd monitor && ./tests/test-synthetic-herdr.sh
```

Captured `hc get dsh-herdr` (full JSON in `evidence/synthetic/get-*.json`):

| stage | journal appended | `reported` | `status.state` | `status.kind` | `status.app` | `status.title` | `status.msg` | turn |
|---|---|---|---|---|---|---|---|---|
| start (idle) | — | true | `idle` | – | dsh-tui | Fix the failing test | title: Fix the failing test | 0 |
| turn + tool | `turn/start`, `tool/call bash` | true | **`working`** | – | dsh-tui | Fix the failing test | bash: $ npm test -- --run | 0 |
| approval | `approval/asked` | true | **`blocked`** | **`permission`** | dsh-tui | Fix the failing test | approval: bash | 1 |
| resolved | `approval/decided`, `tool/result`, `turn/end` | true | **`idle`** | – | dsh-tui | Fix the failing test | turn 1 done | 1 |
| question | `turn/start`, `tool/call ask_user_question` | true | **`blocked`** | **`question`** | dsh-tui | Fix the failing test | question: Pick a branch strategy | 1 |
| answered | `tool/result`, `turn/end` | true | **`idle`** | – | dsh-tui | Fix the failing test | turn 2 done | 1 |

`turn` is herdr-core's own counter; it increases each time the root record
leaves `working` — so the terminal behaves exactly like a real agent.

Activity feed read with `hc read` (full text `evidence/synthetic/feed.txt`):

```text
[demo-000] 13:42:38 ── turn 1 started ──
[demo-000] 13:42:38 ⚙ bash $ npm test -- --run
[demo-000] 13:42:38 ● working — bash: $ npm test -- --run
[demo-000] 13:42:38 ⏸ approval needed: bash — runs a command
[demo-000] 13:42:39 ● blocked — approval: bash
[demo-000] 13:42:39 ▶ approval allowed-once
[demo-000] 13:42:39 ✓ bash done (1690ms)
[demo-000] 13:42:39 ── turn 1 ended (done) ──
[demo-000] 13:42:39 ● idle — turn 1 done
[demo-000] 13:42:40 ⚙ ask_user_question Pick a branch strategy
[demo-000] 13:42:40 ● blocked — question: Pick a branch strategy
```

State JSON written during the same run (full docs under
`evidence/synthetic/state-*.json`):

```json
{
  "schemaVersion": 1,
  "updatedMs": 1793792560517,
  "producer": "dsh-monitor-sidecar",
  "host": { "pid": 165435, "profile": "web", "herdr": true, "terminalId": "t5" },
  "sessions": [
    {
      "id": "demo-0001", "title": "Fix the failing test",
      "status": "blocked", "activity": "approval: bash",
      "updatedMs": 1793792559836, "blockedReason": "approval",
      "source": "log-tail"
    }
  ]
}
```

## 2. Live read-only test — your real sessions (isolated hc core)

`tests/test-live-hc.sh` starts `dsh-herdr` in an isolated core terminal and
points it at the real `~/.dsh/sessions`. It never contacts the DSH host, never
prompts a session, and never writes to the journals (read-only `stat` +
`read`). Reproduce with the same env as §1:

```sh
cd monitor && ./tests/test-live-hc.sh
```

Captured `hc get dsh-herdr-live` (`evidence/live/get-live-all.json`):

```text
reported=true | state=working | app=dsh-tui | title=DSH-Herdr plugin OSC 7501 integration
msg=write done (+5 more working) | turn=0
```

Aggregate feed (full text `evidence/live/feed-live-herdr.txt`), 8 real
sessions found, aggregate working while the team ran:

```text
  a2e0a989 working  13:43:04 DSH-Herdr watch feed prototype
  a5108922 working  13:43:02 DSH-Herdr plugin OSC 7501 integration
  57887e2d working  13:43:02 Herdr protocol spec research
  e5b55b9b working  13:42:59 integrate dsh with herder core
  7f4deb09 working  13:42:55 Herdr DSH monitor UI integration
  cd36f447 working  13:42:54 Fix flaky login tests
  45491157 idle     13:25:23 Refactor the payments module.
  6adc445d idle     13:25:05 DSH experimental plugins overview

[57887e2d] 13:43:06 ⚙ bash $ curl -s --max-time 20 "https://raw.githubusercontent.com/ghostty-org/...
[7f4deb09] 13:43:06 ✓ bash done (217ms)
[a5108922] 13:43:07 ⚙ write /home/you/src/dsh-plugin/package.json
[a5108922] 13:43:07 ✓ write done (17ms)
[7f4deb09] 13:43:10 ⚙ read_image /tmp/glyph-zoom.png
```

Single-session `dsh-watch` on a real live journal
(`evidence/live/get-live-one.json` + `feed-live-watch.txt`):

```text
title   Herdr DSH monitor UI integration
session 7f4deb09-b848-45ce-9ee0-8b482d19c77f  cwd=/home/you/src/acme-app
[13:43:10] ⚙ read_image /tmp/glyph-zoom.png  (history)
[13:43:15] ⚙ bash $ cd /tmp && magick dsh-monitor-live.png -crop 44x44+632+915 ...
[13:43:15] ✓ bash done (171ms)
hc get → reported=true state=working app=dsh-tui title=Herdr DSH monitor UI integration msg=bash done
```

## 3. OSC 7501 protocol probes (isolated hc core)

Plain vs base64 `title`/`msg` (same isolated core; see API-NOTES §3):

```console
$ hc run --bg --name oscplain /tmp/probe4/osc-plain.sh   # title=Plain Title (plain)
$ hc get oscplain → "status":{"app":"dsh-tui","state":"working"}         # title/msg dropped
$ hc run --bg --name oscb64 /tmp/probe4/osc-b64.sh       # base64 title/msg
$ hc get oscb64   → "status":{"app":"dsh-tui","msg":"doing a thing",
                              "state":"working","title":"Plain Title"}   # decoded
```

Also verified: `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, `HC_SESSION`, `HC_SCOPE`
are injected into programs that herdr-core starts; a program that exits
naturally has its status record reset by the core (`state=clear` is sent by the
monitor for tidy teardown anyway).

## 4. Third-party `dsh-tui` v0.2.19 compatibility probe (against the live host)

Its runtime deps were installed only in `/tmp/dsh-tui-pkg/package`
(`npm install --omit=dev`, 40 packages; nothing global, PATH unchanged). Both
commands are rejected at the host's auth fence **before** any handler runs —
no session is created or mutated:

```console
$ DSH_URL=http://127.0.0.1:3080 node bin/tui.js < /dev/null
dsh-tui: HTTP 401 from session.list

$ DSH_URL=http://127.0.0.1:3080 node bin/tui.js run "say hi"
dsh-tui: HTTP 401 from session.create
```

Its transport expects the old API (`session.list` dotted methods, SSE
`/api/events.mux`, `POST /api/respond`) while the running 0.2.2-rc.1 host
exposes `/`-namespaced Typert endpoints over WebSocket `/api/remote.mux`
behind a browser-session cookie. See API-NOTES §1.4.

## 5. Known gaps not yet tested live

- No live `approval/asked` / question occurred in the scanned journals during
  the test window; both blocked paths were exercised synthetically. Mechanism
  is documented and journal-derived (API-NOTES §2.5).
- Multi-producer state-file merging was verified by the herdr-app mod owner
  (`herdr-app-ui`) with sample + live canonical files, not by these scripts.
- Very large journals (>10 MiB decompressed) were not exercised; decode cost is
  O(file) per change (see README Gaps).

## Regression checks

`npm test` runs syntax checks, launcher fixtures, and Node regression tests for
native plugin questions and permissions, private outputs, installer rollback,
panel merging, transient reads, subprocess deadlines, and serialized polling.
All session data and installation targets are temporary synthetic fixtures.

`tests/install.test.mjs` also gives the synthetic Herdr probe an incorrect
reported state and asserts that the probe fails.

The live synthetic probe now runs `bin/dsh-herdr watch` and asserts both the
Herdr OSC record and the state document at every transition. Run
`monitor/tests/test-synthetic-herdr.sh` using the isolation settings above.
