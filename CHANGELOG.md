# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-11-04

First public release.

### Added

- `dsh-herdr` reporter with three modes:
  - `attach` — injects OSC 7501 status into the pane an already-running `dsh web`
    host occupies, so Herdr shows it as a "DeepSeek Harness" agent without a dsh
    restart and without an HTTP token (the host's session journals are the data
    source).
  - `watch` — standalone monitor pane with a live activity feed for every
    session (or one session with `--session`).
  - `daemon` — discovers `dsh web` panes on herdr-core and keeps a reporter
    attached, re-attaching after host restarts.
- State document at `~/.local/state/dsh-herdr/agents.json` (mode 0600) for UI
  consumers, with aggregate status, per-session status/activity/cwd/turn and
  blocked reasons.
- `dsh-monitor` Herdr panel mod: live session list, status glyphs, activity,
  ages, counts, web-GUI link; implemented without extra dependencies.
- Herdr program entries: "DeepSeek Harness" display entry (name + DeepSeek icon)
  and a "DeepSeek Harness (monitor)" launcher entry in the agent menu.
- Optional native DSH host plugin (`plugin/`): a DSH bundle that reports from
  inside the host process (OSC 7501 on its stdout/tty) and writes the same state
  document; installs into a separate profile and survives host restarts.
- Blocked detection: journaled `approval/asked`/`approval/decided` pairs and
  structurally pending `ask_user_question` / `exit_plan_mode` tool calls.
- Installer with `--start`, `--systemd` (Linux), `--plugin`, `--uninstall`;
  npm-installable launcher (`npm install -g dsh-herdr`).
- Verified OSC 7501 protocol reference with executable probes and raw evidence
  under `research/`; reference journal sidecars and API notes under `monitor/`.
- CI (Linux + macOS): syntax checks, fixture smoke tests, ShellCheck, npm pack
  validation.

### Notes

- Linux is fully verified; macOS is expected to work (attach uses `ps -o tty=`)
  but was not tested on hardware at release time. Windows is not supported yet.
- The dsh session journal (`session.v4.jsonl.zstd`) is an internal persistence
  format; the optional native plugin path does not depend on it.

[0.2.0]: https://github.com/mitkox/dsh-herdr/releases/tag/v0.2.0
