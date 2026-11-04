# STATE-SCHEMA — the shared DSH → Herdr state document

Status: authoritative for the `herdr-status` DSH host plugin. Coordinated with
`herdr-app-ui` (monitor mod) and `dsh-monitor` (no-restart sidecar): one
document shape, several producers, each writing atomically.

## Canonical file and env overrides

| Producer | Mode | File | When |
|---|---|---|---|
| `bin/dsh-herdr` launcher (attach/daemon reporter) | `attach` | `~/.local/state/dsh-herdr/agents.json` | host already running, no restart |
| `plugin` (this plugin, in-process) | `plugin` | `~/.local/state/dsh-herdr/agents.json` | host runs with the plugin installed |
| `monitor` dsh-monitor sidecar | `sidecar` | `/tmp/dsh-herdr-sidecar-state.json` (dev) | log-tail fallback |

- Canonical path: `~/.local/state/dsh-herdr/agents.json`. The plugin resolves it
  from `$HOME`; the launcher honours `XDG_STATE_HOME` when set. Both accept the
  `DSH_HERDR_STATE` override.
- Override (absolute file path): `DSH_HERDR_STATE=/abs/file.json`. The plugin also
  honors `DSH_PLUGIN_STATE_FILE` (alias) and the loader row config `stateFile`.
- Writers must be atomic: write `<path>.<pid>.tmp` then `rename()` in the same
  directory. Readers must tolerate a missing file, a partially stale file, and
  unknown extra fields.
- Only one in-process producer should write the canonical path per host. The
  attach launcher and this plugin may alternate writes (same shape, last writer
  wins); stop the attach launcher when the plugin host is restarted so the
  plugin becomes the sole writer.

## Document (JSON object)

```jsonc
{
  "version": 1,                  // document format version (launcher spelling)
  "schemaVersion": 1,            // same value; both spellings are accepted by readers
  "updatedMs": 1762345678901,    // ms epoch of this write; heartbeat <= 5s while alive
  "producer": "dsh-plugin-herdr",// or "dsh-herdr" (launcher) / "dsh-monitor-sidecar"
  "mode": "plugin",              // "plugin" | "attach" | "sidecar"
  "pane": "t2",                  // Herdr terminal id when known, else null
  "hostPid": 45080,              // pid of the DSH host process
  "tty": "/dev/stdout (tty)",    // OSC sink description, or null
  "host": {
    "url": "http://127.0.0.1:3080", // clean Web GUI URL (no token)
    "pid": 45080,
    "terminalId": "t2",          // HC_TERMINAL_ID, else null
    "herdr": true,               // true when HC_TERMINAL_ID/HC_TERMINAL_SOCKET were present
    "profile": "web",            // DSH profile name when known
    "osc": true,                 // OSC 7501 reporting active in this process
    "startedMs": 1762345200000
  },
  "aggregate": {
    "state": "working",          // "blocked" | "working" | "idle"
    "title": "integrate dsh with herder core", // most relevant session title or null
    "msg": "thinking",           // current activity text or null
    "working": 9                 // number of sessions in working/blocked
  },
  "sessions": [                  // ordered: blocked, working, idle, done (newest first within a group)
    {
      "id": "session-f3a6d2d3-...", // DSH session id
      "title": "You are gh-scout on a", // best known title; the id when no title yet
      "cwd": "/home/you/src/acme-app", // session workspace, "" when unknown
      "preset": "standard",      // agent preset, "" when unknown
      "depth": 0,                // 0 = root session, 1+ = subagent depth
      "status": "working",       // "working" | "blocked" | "idle" | "done"
      "activity": "bash $ ls -la", // human-readable current activity; never a dict
      "turn": 1,                 // turn counter observed for this session
      "updatedMs": 1762345678000,// last status/activity/title change for this session
      "lastTurnEndMs": null,     // ms epoch of the last finished turn, or null
      // optional, only when applicable:
      "blockedReason": "permission", // "permission" | "question", only when blocked
      "parentSessionId": "session-..." // only for subagent sessions
    }
  ]
}
```

### Field semantics

- `status`: `working` = a turn is running; `blocked` = DSH is waiting for the
  user (an approval prompt or an `ask_user_question` card); `idle` = ready;
  `done` = the session's agent was disposed; readers may show it briefly, then
  the record disappears (plugin keeps it for 30s).
- `activity` is always a display string for readers: `"thinking"`,
  `"running bash: <command>"`, `"approval: bash"`, `"waiting for your answer"`,
  the question text, or `"waiting for activity…"` when idle.
- `aggregate.state` precedence: `blocked` > `working` > `idle`; `aggregate.title`
  is the title of the most recently updated root session (subagents are used only
  when no root session exists); `aggregate.msg` mirrors `activity`.
- `updatedMs` (top level) is the document generation time — it advances on every
  write including the ≤5s heartbeat, so a reader treats a document older than
  ~20s as a stopped writer.
- `host.url` is the clean GUI URL; it never carries the launch token.

## Merge rules for the Herdr app mod

1. Poll `~/.local/state/dsh-herdr/agents.json` (canonical) first.
2. Optional extra producers can be passed to the panel as pane props
   (`{ "paths": ["/abs/other-state.json"] }`); merge by session id: the record
   with the fresher session `updatedMs` wins.
3. Tolerate: missing file, missing fields, unknown extra fields, null titles,
   sessions appearing/disappearing.

## Plugin-specific notes

- The plugin always writes the document (even without Herdr detection); `host.herdr`
  says whether OSC reporting is active.
- `DSH_HERDR_DISABLE=1` prevents the plugin from mounting at all.
- This document is not a queue: readers never write it.
