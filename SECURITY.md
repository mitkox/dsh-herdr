# Security policy

## Reporting a vulnerability

Please report privately via a GitHub security advisory on this repository
(<https://github.com/mitkox/dsh-herdr/security/advisories/new>), or by contacting
the maintainers listed in `package.json`. Do not open a public issue for a vulnerability. We aim to
respond within a week.

## Threat model

`dsh-herdr` is a local, single-user tool that sits between two programs on your
machine:

- it **reads** dsh session journals under `$DSH_HOME/sessions/`,
- it **writes** (a) terminal escape sequences (OSC 7501 status, OSC 2 title),
  (b) a JSON state document under `$XDG_STATE_HOME/dsh-herdr/`,
  (c) files in `~/.local/bin` and `~/.config/herdr-app` when you run the
  installer,
- the optional DSH plugin runs inside your dsh host and does the equivalent from
  in-process,
- the Herdr panel mod reads the state document and renders it.

There is **no network listener**, no telemetry and no remote code loading in any
of these components.

### Sensitive data

Session journals and the state document contain conversation titles, user
prompts, tool commands and file paths. Treat them as private:

- the state document is written with mode `0600`; the journals are owned by dsh
  and already `0600`,
- do not paste unredacted state documents or journals into issues,
- `dsh-herdr watch` prints activity to the terminal you start it in.

### escape-sequence writing (`attach` mode)

To make the pane your dsh host already runs in report as an agent, `attach`
writes a small OSC 7501 record (and a title) into that pane's pty from a child
process. It writes only escape sequences — never keyboard input, never commands
— but it does share the terminal output stream with the host process. If you do
not want that, use the native DSH plugin (`plugin/`) instead, which reports from
inside the host.

### Installer

`install.sh` copies files into your home directory, merges entries into
`~/.config/herdr-app/programs.json` (with a backup), and may install a
`systemd --user` unit. It never uses `sudo`, never writes outside `$HOME`, and
touches only the paths it prints. Review the script before running it.

## Scope

Out of scope for this project: vulnerabilities in dsh, Herdr or Node.js
themselves (report those upstream); issues that require an attacker who already
has your user account or filesystem access.
