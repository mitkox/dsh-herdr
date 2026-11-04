# Compatibility

Tested matrix (most recent verification first). Add your own row via a PR when
you validate another combination.

| dsh | herdr-core (`hc`) | herdr-app | OS | What was verified |
|---|---|---|---|---|
| 0.2.2-rc.1 | 0.1.17 | 0.1.12 | Linux x86_64 | end-to-end: agent row with icon + state, panel, `attach`/`watch`/`daemon`, fixture smoke tests, plugin in isolated core+scratch host |
| 0.2.1-rc.2 source | — | — | Linux | journal format/API reference only (dev checkout) |

Expected to work but not yet verified on a real installation:

- **macOS (Apple Silicon / Intel)**: the panel, `watch` and the DSH plugin are
  platform-neutral. `attach` mode uses `ps -o tty=` to find the host's terminal
  instead of Linux `/proc`; run `dsh-herdr attach --pane <pane>` there and report
  back.
- **Herdr app ≥ 0.1.13**: newer `herdr-app` builds ship a built-in `dsh-tui`
  program entry ("DeepSeek Harness" + DeepSeek icon). If present, the
  `programs.json` entries this project installs are a harmless override; if not
  (0.1.12 and earlier), they are required.

Not supported yet:

- **Windows**: the reporter's pty discovery and the installer's service step are
  POSIX-only; `watch` may work but is untested.
- **Herdr remote machines (`--machine`)**: panes on SSH machines are skipped by
  `daemon`; their sessions still appear in the panel because the journals are
  local to the machine running dsh.
- **Herdr TUI** (the older `herdr` multiplexer, 0.9.x): a different program with
  its own server; this project targets herdr-core + herdr-app.

## Known caveats

- **Journal format is internal.** `session.v4.jsonl.zstd` is a dsh persistence
  detail, not a public API. The reader tolerates concatenated zstd frames,
  truncated tails and versioned filenames, but a future dsh version may change
  the event shapes. The native plugin path does not depend on the journal format.
- **Blocked-state detection without the plugin** relies on journaled
  `approval/asked`/`approval/decided` pairs and structurally on pending
  `ask_user_question` / `exit_plan_mode` calls. Approvals that are auto-answered
  may resolve faster than the poll interval; user questions are not journaled as
  their own event.
- **Aggregate granularity.** One herdr-core pane (one dsh host) reports one
  agent. Multiple sessions in that host are aggregated `blocked > working >
  idle`; the title follows the busiest top-level session. The panel shows every
  session individually.
- **titles/msg limits.** Herdr accepts base64 `title` ≤ 192 decoded bytes and
  `msg` ≤ 2048 decoded bytes; the reporter clamps both.
- **`app=dsh-tui`** is the reported program key so Herdr's "DeepSeek Harness"
  name/icon entry applies.

## Version checks

```sh
node --version     # >= 22.15
hc --version       # herdr-core; run `hc --help` for its manual
herdr-app --version
dsh --version
```
