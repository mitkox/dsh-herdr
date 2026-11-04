# herdr-status — DSH host plugin for Herdr

A DeepSeek Harness (dsh) **host plugin** that makes a running dsh host visible
inside Herdr (`herdr-core` + `herdr-app`) and publishes its live sessions for the
Herdr app monitor mod.

Two independent outputs, both failure-isolated from the host:

1. **OSC 7501 status reports on the host's terminal** — only when the host runs
   in a Herdr-managed terminal (`HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET` present).
   Reports `app=dsh-tui` (Herdr's built-in "DeepSeek Harness" name + DeepSeek
   icon), `state=idle|working|blocked`, `kind=permission|question` while blocked,
   the active session title, and the current activity. Multi-session aggregate:
   `blocked > working > idle`.
2. **An atomic per-session JSON state document** at
   `~/.local/state/dsh-herdr/agents.json` (override `DSH_HERDR_STATE`) consumed by
   the Herdr app monitor mod. Schema: [STATE-SCHEMA.md](STATE-SCHEMA.md).

Reporting can never crash or slow the host: every stdout write, fs write, timer,
and event handler is contained, errors are rate-limited, and dispose removes all
timers/listeners. Tested end to end: see [TESTING.md](TESTING.md).

## What it reports

| DSH lifecycle | Herdr `state` | `kind` | `title` | `msg` |
|---|---|---|---|---|
| any turn running | `working` | — | most recently active session title | `thinking` / `running bash: <cmd>` / … |
| approval prompt pending (`approval/asked`) | `blocked` | `permission` | blocked session title | `approval: <tool>` |
| `ask_user_question` pending | `blocked` | `question` | blocked session title | the question text |
| no turn running | `idle` | — | most recently active session title | — |

Subagent sessions are tracked too (state file only, `depth` + `parentSessionId`);
a blocked subagent still raises the aggregate to `blocked`.

## Requirements

- dsh `0.2.x` (verified with `0.2.2-rc.1`; the plugin has no package
  dependencies and imports only Node built-ins).
- Herdr `hc 0.1.17` (the OSC 7501 protocol it parses) and `herdr-app` for the UI.
- Node `^22.19.0 || >=24.0.0` (the host's Node is used).

## Install

The plugin is a DSH **bundle** package (`dsh.bundle.patch` in
`package.json`), so installing it into a profile also activates its patch layer.

### Script (recommended) — new profile `herdr`, never touches `web`

```sh
plugin/install.sh                       # default: profile "herdr" under $DSH_HOME
plugin/install.sh --profile herdr       # explicit
plugin/install.sh --dry-run             # show the commands only
plugin/install.sh --profile herdr --uninstall   # remove the plugin again (alias: --rollback)
```

The script:

1. runs `dsh plugin --profile <name> add <this directory>` (creates the profile
   on first use, installs the package as a `link:` dependency, and the profile's
   bundle list gains `dsh-plugin-herdr` automatically);
2. adds the shipped `@deepseek-ai/dsh-web-app` bundle when the new profile has
   no web surface yet (a non-shipped profile name initializes with `dsh-base`
   only);
3. prints the activation steps and the state-file path.

It refuses to target the live `web` profile unless `--allow-web` is passed.

### Manual equivalent

```sh
dsh plugin --profile herdr add /path/to/plugin
# fresh profile only: add "@deepseek-ai/dsh-web-app" to dsh.profile.bundles in
#   $DSH_HOME/profiles/herdr/package.json
```

## Activate / disable

The plugin is loaded at host boot, so a host that was already running must be
**restarted inside its Herdr pane** for the plugin to load:

1. In the Herdr pane running dsh, stop the host (Ctrl-C).
2. Restart it there: `dsh --profile herdr` (add `--port <port>` / `--no-open` as
   needed). Sessions persist; reopen the printed tokenized URL in the browser.
3. Verify from another shell: `hc get <pane-address>` → `status.state` becomes
   `idle` and `status.app` is `dsh-tui`; or watch `~/.local/state/dsh-herdr/agents.json`.

- **Disable temporarily**: start the host with `DSH_HERDR_DISABLE=1`; the plugin
  does not mount (no OSC, no state file).
- **Disable OSC only**: config `osc: false` (state file still written) via the
  profile patch row:
  ```yaml
  - id: herdr-status
    config:
      osc: false
  ```
- **Uninstall/rollback**: `plugin/install.sh --profile herdr --uninstall`
  (removes the package dependency; the profile directory and its sessions stay).

## Configuration (all optional)

Row config in the profile's `cordis.patch.yml` (`- id: herdr-status`):

| Key | Default | Meaning |
|---|---|---|
| `stateFile` | `~/.local/state/dsh-herdr/agents.json` | Absolute (or cwd-relative) state-document path. |
| `osc` | `true` | Emit OSC 7501 when Herdr is detected. |
| `app` | `dsh-tui` | Herdr `app` field (name set `[A-Za-z0-9._-]`, ≤32 bytes). |
| `enabled` | `true` | Mount the plugin at all. |
| `heartbeatMs` | `5000` | State-document heartbeat (readers treat >20 s as stale). |
| `debounceMs` | `100` | Coalesce bursts of lifecycle events. |
| `debug` | `false` | Append a JSONL event trace beside the state file. |

Environment overrides: `DSH_HERDR_STATE` (state file path, canonical),
`DSH_PLUGIN_STATE_FILE` (alias), `DSH_HERDR_DISABLE=1` (off), `DSH_HERDR_DEBUG=1`
(trace). Herdr detection uses `HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET`; the plugin
also stores the terminal id in the state document (`host.terminalId`, `pane`).

## How the OSC report is written

One report per change, as a raw escape sequence on the host's stdout (its Herdr
pty): `ESC ] 7501 ; state=<s>[:kind=<k>][:app=dsh-tui][:title=<b64>][:msg=<b64>] ESC \`.
`title`/`msg` are **base64-encoded UTF-8** (Herdr rejects plain values); limits
are title ≤192 bytes and msg ≤2048 bytes decoded, control characters are
rejected, so the plugin cleans and bounds both. Writing to a captured/non-TTY
stdout never happens: if stdout is not a TTY the plugin falls back to
`/dev/tty`, so `dsh ... | tee log` still reports and the log stays clean.

## Files

| File | Purpose |
|---|---|
| `index.js` | The plugin (plain ESM, no build step, no dependencies). |
| `package.json` | Bundle manifest (`dsh.bundle.patch`), exports `.`. |
| `cordis.patch.yml` | Bundle layer: inserts the `herdr-status` row. |
| `install.sh` | Profile installer + rollback. |
| `STATE-SCHEMA.md` | Shared state-document contract (producers, fields, merge rules). |
| `TESTING.md` | End-to-end evidence from an isolated Herdr pane + scratch host. |
| `test/drive.mjs` | Cookie/token DSH API driver used by the probe (also handy for demos). |
| `evidence/` | Captured `hc get`/state samples and probe outputs. |

## Limitations

- Takes effect only after a host restart (see "Activate").
- OSC reporting requires the host's stdout (or controlling terminal) to be the
  Herdr pty; a daemonized host with no terminal cannot report.
- A permission prompt is reported from the durable `approval/asked` →
  `approval/decided` pair; a question from the pending `ask_user_question`
  tool call. If the host is reloaded while a prompt is pending, the new instance
  does not see the pending approval until it resolves (documented gap).
- `host.profile` is best-effort (loader `profileContext` service, then
  `DSH_PROFILE`); other fields are always present.
