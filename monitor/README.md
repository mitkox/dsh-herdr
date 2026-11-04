# DSH ↔ Herdr live monitor (reference implementation)

Watch a DeepSeek Harness (dsh) agent work **from inside Herdr**, and make it
appear as a real Herdr agent (sidebar row, "needs you" state, notifications) —
**with no DSH host restart, no HTTP token, and no writes to DSH**.

Two plain-Node programs (no npm dependencies):

| File | Purpose |
|---|---|
| `dsh-watch.mjs` | watch **one** DSH session: readable live feed + OSC 7501 status for *that* herdr terminal |
| `dsh-herdr.mjs` | watch **all** DSH sessions: aggregate feed, aggregate OSC 7501, and an atomic state JSON for the herdr-app monitor mod |
| `lib/sessionlog.mjs` | tolerant tailing/folding of DSH session journals (`session.v4.jsonl.zstd`), status derivation, approval/question detection |
| `lib/osc.mjs` | OSC 7501 reporter (base64 title/msg, debounce, heartbeat, `clear` on exit) |
| `lib/statefile.mjs` | atomic state-file writer (schemaVersion 1, tmp+rename) |
| `lib/format.mjs` | feed formatting / tool-argument summaries |
| `tests/` | fixture writer + two reproducible end-to-end tests (synthetic + live read-only) |
| `API-NOTES.md` | host API/auth findings, journal format, event shapes, blocked detection, OSC grammar |
| `TESTING.md` | commands + captured evidence (`hc get` transitions, feeds, state JSON) |
| `evidence/` | raw captured test artefacts |

> **This directory is a reference implementation, not the installed path.**
> The installed reporter is `bin/dsh-herdr` (modes `watch` / `attach` / `daemon`);
> it writes the canonical state document `~/.local/state/dsh-herdr/agents.json`
> (env `DSH_HERDR_STATE`), which the Herdr panel reads. These sample sidecars are
> kept so the journal-reading and OSC-emitting parts can be understood and reused
> in isolation; to avoid racing the canonical writer, `dsh-herdr.mjs` defaults its
> state file to `/tmp/dsh-herdr-sidecar-state.json`. Point it elsewhere with
> `DSH_HERDR_STATE=<path>` when you use it in place of the launcher.

---

## Why journal tailing (the short version)

DSH 0.2.2-rc.1 hosts its agents inside `dsh web`; the host's `/api` is fenced
by a launch-token → signed-cookie exchange, and the launch token exists only in
the host's own terminal. A monitor process cannot obtain it. What every host
*does* write is an append-only session journal:

```
$DSH_HOME/sessions/<cwd-slug>/<session-dir>/session.v4.jsonl.zstd
```

JSONL compressed as concatenated zstd frames, appended near-real-time
(same-second observed). It contains `turn/start`/`turn/end`, `tool/call`,
`tool/result`, `assistant/message`, `session/title`, and the log-only audit
pair `approval/asked` + `approval/decided` — enough for a live feed and for
`working` / `blocked` / `idle` state. Full details and caveats: `API-NOTES.md`
§2, including **user questions are not journaled** (detected structurally from
an unmatched `ask_user_question` / `exit_plan_mode` tool call).

Monitor lag = host append flush + poll interval (`--poll-ms`, default 400 ms).

## TL;DR — run it

It is read-only from start to finish; it never contacts the DSH host, never
prompts a session, never restarts anything.

```sh
cd /home/you/src/dsh-monitor

# 0) what can I watch?
node dsh-watch.mjs --list

# 1) one session in a herdr pane (OSC auto-enables only when it owns the PTY)
hc run --bg --name dsh-watch node "$PWD/dsh-watch.mjs" --history 12
hc get dsh-watch; hc read dsh-watch --lines 60

# or run it interactively in any terminal (feed works, OSC disabled outside Herdr):
node dsh-watch.mjs <session-id-prefix>

# 2) all sessions in one pane + state JSON + aggregate OSC
node dsh-herdr.mjs --state-file /tmp/dsh-herdr-sidecar-state.json
hc run --bg --name dsh node "$PWD/dsh-herdr.mjs"    # inside herdr

# 3) one-shot status check (no TUI/loop)
node dsh-watch.mjs --once
node dsh-herdr.mjs --once --no-state
```

Useful options: `--sessions-dir DIR` (default `$DSH_HOME/sessions`, else
`~/.dsh/sessions`), `--file JOURNAL`, `--poll-ms`, `--stale-ms`, `--app`,
`--no-osc` / `--osc`, `--no-color`, `--verbose`, `--once`.
`DSH_HERDR_STATE` overrides the sidecar state path; `DSH_HERDR_APP` overrides
the reported app name.

What Herdr shows once running in a pane: program **"DeepSeek Harness"**
(built-in `dsh-tui` entry + DeepSeek icon), status `working`/`idle`/`blocked`,
title = session title, message = current activity (`bash $ npm test`,
`approval: bash`, `question: …`, `(+N more working)` in all-session mode).

---

## Feasibility: how should the user see the DSH agent in Herdr?

Three candidate architectures were evaluated. Evidence in `API-NOTES.md` and
`TESTING.md`.

### (a) `dsh-watch` sidecar per session — **works today, zero install**

A plain Node process in one herdr terminal, tailing one session journal,
printing a feed and reporting OSC 7501.

- **Effort:** done (this directory). No install, no PATH change, no host restart.
- **Robustness:** good for observation: journal is append-only and never
  locked against readers; tolerant decode handles the host's partial trailing
  zstd frame; stale-turn cutoff prevents stuck `working`.
- **Weaknesses:** one pane per session; it only sees what is journaled (no
  live token streaming, no transient "pending question" beyond the unmatched
  tool-call heuristic, no approval *outcome* until `approval/decided` appears);
  journal format is internal and may change between DSH versions (pin/verify on
  upgrade); O(file) decode per change (fine ≤ ~10 MiB, see Gaps).
- **Best for:** "I want to watch this specific agent work and see its tool
  activity, now, without touching my setup."

### (b) real `dsh-tui` in a pane + sidecar reporter — **not viable on this host**

Install the MIT TUI, run it in a herdr pane, and have a wrapper report OSC
since the TUI has no hook.

- **Blocker (empirical):** `dsh-tui` v0.2.19 (last published 2026-08-14) targets
  the **old DSH client API**: dotted methods (`session.list`), SSE
  `GET /api/events.mux`, `POST /api/respond`, no auth cookie. The running host
  is DSH **0.2.2-rc.1**, which fences `/api` behind the launch-token cookie and
  serves `/`-namespaced endpoints over `/api/remote.mux` WebSocket. Probes:
  `dsh-tui: HTTP 401 from session.list` / `from session.create` (TESTING §4).
- **Second problem:** even if it ran, a sidecar cannot reliably infer *which
  session the TUI is on* — the TUI keeps that client-side; the host has no
  "current session" API. The sidecar could watch terminal output or newest
  journal mtime, both fragile.
- **Effort:** large (an API compat shim = re-implement Connection auth + the
  Gateway stream protocol + endpoint mapping for a third-party TUI). Not worth
  it for monitoring; revisit only if upstream `dsh-tui` is updated for 0.2.2.
- **Verdict:** do not install globally / do not ship. Keep the idea for later.

### (c) host-level aggregate reporting by the dsh-plugin host plugin — **best long-term**

Teammate `dsh-plugin` mounts a plugin in the DSH host: real lifecycle events
(`turn/start`, `turn/end`, `agent/status`, approval/question request events),
true blocked state incl. transient questions, and a state file
(`state/dsh-agents.json`). **`bin/dsh-herdr attach` mode** is
the complementary piece: it writes OSC into the host's *existing* herdr pane
(`/proc/<hostpid>/fd/1`), so the pane the user already looks at becomes the
"DeepSeek Harness" agent — no extra terminal, no restart.

- **Effort:** plugin must be installed into a profile and the host restarted to
  load it (rollback documented by dsh-plugin); `attach` needs the host to run
  inside a herdr pane (it does: pane `t2`, pid 45080).
- **Robustness:** best state fidelity (it is the real event source, no journal
  parsing, no polling); transient approvals/questions and multi-agent
  aggregation are exact. Risk: host plugin failures must never crash/slow the
  host (debounce, try/catch, dispose) — owned by dsh-plugin.
- **Best for:** your daily setup: their existing DSH pane is the
  agent, and the herdr-app mod reads one canonical state file.

### Recommendation

**Ship (c) as the primary, (a) as the always-available fallback, (b) never.**

- Primary: dsh-plugin host plugin (OSC + canonical state file) with
  `bin/dsh-herdr attach` for the existing pane, `... watch` for a
  dedicated monitor pane. Highest fidelity, one canonical state document
  (`~/.local/state/dsh-herdr/agents.json`), herdr-app mod already reads it.
- Fallback / reference: `monitor/dsh-watch.mjs` and `dsh-herdr.mjs` —
  zero-install, works against **any** already-running DSH host (including one
  started before this integration or not running in a Herdr pane at all, i.e.
  the state file / feed still works), and it is the debugging tool if the
  plugin is unavailable. This sidecar's state file should be opt-in
  (`DSH_HERDR_STATE=<repo>/state/dsh-sidecar.json`) so it never competes
  with the canonical writer.
- Do not install `dsh-tui`; its API is stale for 0.2.2-rc.1 and the real TUI
  adds no monitoring capability the journal/host-plugin paths lack.

## What the session-log library handles (and what it doesn't)

Implemented in `lib/sessionlog.mjs` (usable by other teammates):

- **Partial-write safety:** concatenated-zstd-frame journals are decoded with a
  streaming decoder; on `unexpected end of file` the decodable prefix is kept
  and only `\n`-complete JSONL lines are folded. A mid-write poll never
  corrupts state or loses lines (retried next poll).
- **Compaction/rewrite detection:** if the decoded text no longer extends the
  previous text, the fold restarts from the new content.
- **Turn state:** `working` iff the last `turn/start` has no later
  `turn/end`; a turn with no journal activity for `staleMs` (default 15 min) is
  downgraded to `idle` with a `stale:` activity (host-crash safety). Turn
  counter/reason preserved from `turn/end` (`done`/`error`/…).
- **Approval-ish events:** `approval/asked` without `approval/decided` ⇒
  `blocked:kind=permission`, activity = `approval: <toolName>`; unmatched
  `ask_user_question` / `exit_plan_mode` `tool/call` ⇒
  `blocked:kind=question`. `tool/result` pairing uses
  `data.message.toolCallId` / `data.message.source.callId`; failures surface
  from `data.error` / `data.message.error`.
- **Text extraction:** assistant/user text blocks only (reasoning/tool blocks
  ignored); tool arguments are summarised per tool (`command`, `file_path`,
  `pattern`, `url`, question text, …) for both the feed and the OSC `msg`.
- **Not handled:** incremental decompression for very large journals (full
  decode on change is ~2 ms/MiB and simpler than frame-boundary tracking);
  journals older than `--max-age-hours` / beyond `--max-sessions` are skipped in
  all-session mode; `assistant/chunk` token deltas (not journaled — settled
  `assistant/message` is used instead); no live remote-event fidelity (no
  pending-question details, approval reason coverage limited to the audit
  event).

## Dev state file

`dsh-herdr.mjs` writes `schemaVersion 1` JSON:
`{ schemaVersion, updatedMs, producer, host:{pid,profile,herdr,terminalId}, sessions:[{id,title,status,activity,updatedMs,blockedReason?,source}] }`
(atomic tmp+rename, heartbeat every 2.5 s, sessions sorted blocked > working >
idle). Same schema as `plugin/STATE-SCHEMA.md` (dsh-plugin); the app mod
merges this with the plugin and canonical files by session id. Sample:
`samples/dsh-sidecar.sample.json`.

## Gaps / next steps

1. **Live blocked-state validation:** both blocked paths are proven with
  synthetic journals (TESTING §1); no real approval/question occurred in the
  scanned live journals during the test window. Next live approval should be
  re-captured for end-to-end confidence.
2. **Large-journal decode:** full-file decode per change is O(n); implement
  zstd frame-boundary incremental decoding if users regularly exceed
  ~10 MiB journals.
3. **Version guard:** assert journal header `version:4` and surface a clear
  warning if a future DSH changes journal layout/name (the watcher currently
  matches `session.v*.jsonl.zstd` and parses defensively).
4. **Session discovery UX:** `--file`/`--sessions-dir`/`--list` cover scripting;
  a tiny herdr template (`hc templates`) wrapping `dsh-herdr` with a name/cwd
  prompt would standardise launching (not implemented yet)
  canonical launcher).
5. **OSC**: title/msg base64 rule is load-bearing; keep the reporter's
  sanitisation + debounce if the protocol spec (teammate `herdr-protocol`)
  lands and supersedes these notes.

No global installs and no PATH changes were made. Nothing here restarts the
user's host or herdr-core; the only writes are the monitor's own state file
(`/tmp` by default).
