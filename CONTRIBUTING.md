# Contributing to dsh-herdr

Thanks for helping make dsh agents first-class citizens in Herdr.

## Ways to help

- **Bug reports** with the output of `dsh-herdr watch --once` (redact session
  titles if they are private), `hc get <pane>`, `herdr-app status`, OS, Node,
  dsh and Herdr versions.
- **Compatibility reports**: which dsh / herdr-core / herdr-app versions work,
  on which OS. Add a row to [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).
- **New producers**: other agent harnesses that write durable session logs or
  can emit OSC 7501 belong here too — open an issue with the format.
- **Docs and screenshots** (light and dark, current versions).

## Development setup

Requirements: Node.js ≥ 22.15, git, and — for end-to-end tests — a local
[Herdr](https://herdr.dev) install (`hc` + `herdr-app`) and DeepSeek Harness.

```sh
git clone <your-fork> && cd dsh-herdr
npm test                       # static checks + fixture smoke tests (no Herdr/DSH needed)
```

Layout:

```
bin/dsh-herdr          the reporter (watch / attach / daemon / install)
app/                   Herdr app panel mod + program entries + installer
plugin/                optional native DSH host plugin
monitor/               reference journal sidecars, libs, API notes
research/              OSC 7501 spec, probes, evidence
tests/                 syntax checks + fixture smoke tests
install.sh             top-level installer
```

### Testing against a real Herdr / DSH safely

Never restart, kill or reconfigure someone's running Herdr core/app or dsh host
while testing. Use an isolated core and a scratch DSH home:

```sh
export HC_SESSION=dev XDG_STATE_HOME=/tmp/dev/state XDG_CONFIG_HOME=/tmp/dev/config \
       XDG_DATA_HOME=/tmp/dev/data XDG_RUNTIME_DIR=/tmp/dev/run
hc server start

# scratch DSH home for the plugin tests
export DSH_HOME=/tmp/dev/dsh-home
dsh plugin --profile probe add "$PWD/plugin"
dsh --profile probe --port 3181 --no-open
```

`monitor/tests/test-synthetic-herdr.sh` and `test-live-hc.sh` show the
end-to-end pattern. The app-side mod can be validated without touching the
running window:

```sh
herdr-app check app/mods/dsh-monitor
```

## Pull request guidelines

1. One focused change; explain the user-visible effect.
2. `npm test` passes. Changes to `app/mods/dsh-monitor/main.js` or to the
   program entries must also pass `herdr-app check app/mods/dsh-monitor`.
3. Keep the project dependency-free where possible. Runtime code targets Node
   ≥ 22.15 using built-ins only; the panel mod may only import what Herdr
   injects (`gpui-kit`, `gpui-base`, `herdr`).
4. Update docs and, for behaviour changes, the evidence under `research/` or
   `monitor/evidence/` (synthetic or redacted data only — never commit another
   person's session contents).
5. Do not break the two invariants: **read-only towards dsh** and **no network
   access** in the reporter.
6. Commits: clear subject line; sign-offs welcome but not required.

## Reporting security issues

Please do not open a public issue for a vulnerability; see [SECURITY.md](SECURITY.md).
