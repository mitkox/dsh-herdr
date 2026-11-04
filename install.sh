#!/usr/bin/env bash
# dsh-herdr installer — makes a DeepSeek Harness agent visible in Herdr.
#
# What it installs (all additive and reversible):
#   1. ~/.local/bin/dsh-herdr                      the monitor/reporter command
#   2. ~/.config/herdr-app/mods/dsh-monitor/        the Herdr panel that lists DSH sessions live
#   3. ~/.config/herdr-app/programs.json            "DeepSeek Harness" name + icon for the reported app
#   4. (optional) a systemd --user service that keeps every `dsh web` pane attached
#   5. (optional) the native DSH host plugin (plugin/) into a separate `herdr` profile
#
# Usage:
#   ./install.sh                 install files (safe: backs up programs.json)
#   ./install.sh --start         also start the reporter daemon now (needs herdr-core running)
#   ./install.sh --systemd       also install + enable a systemd --user daemon (survives reboots)
#   ./install.sh --plugin        also install the native DSH host plugin into a `herdr` profile
#   ./install.sh --uninstall     remove everything this script installed
#   ./install.sh --help
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
if command -v node >/dev/null 2>&1; then
  REPO_DIR=$(node -e 'console.log(require("node:path").dirname(require("node:fs").realpathSync(process.argv[1])))' "$SELF")
else
  REPO_DIR=$(cd "$(dirname "$SELF")" && pwd -P)
fi
BIN_SRC="$REPO_DIR/bin/dsh-herdr"
MOD_SRC="$REPO_DIR/app/mods/dsh-monitor"
PROGRAMS_SRC="$REPO_DIR/app/programs.json"
PLUGIN_DIR="$REPO_DIR/plugin"

HOME_DIR=${HOME:?}
BIN_DST="$HOME_DIR/.local/bin/dsh-herdr"
APP_HOME=${HERDR_APP_HOME:-$HOME_DIR/.config/herdr-app}
MOD_DST="$APP_HOME/mods/dsh-monitor"
PROGRAMS_DST="$APP_HOME/programs.json"
BACKUP_DST="$APP_HOME/programs.json.dsh-herdr.bak"
UNIT_DIR="$HOME_DIR/.config/systemd/user"
UNIT_DST="$UNIT_DIR/dsh-herdr-daemon.service"
STATE_DIR="${XDG_STATE_HOME:-$HOME_DIR/.local/state}/dsh-herdr"

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

stop_reporters() {
  for f in "$STATE_DIR"/attach-*.json; do
    [ -f "$f" ] || continue
    local pid
    pid=$(F="$f" node -e 'try { console.log(JSON.parse(require("node:fs").readFileSync(process.env.F, "utf8")).pid || "") } catch { console.log("") }' 2>/dev/null || true)
    [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
    rm -f "$f"
  done
  # The daemon also re-spawns reporters, so stop it first when it is ours.
  local dpid
  dpid=$(cat "$STATE_DIR/daemon.pid" 2>/dev/null || true)
  [ -n "${dpid:-}" ] && kill "$dpid" 2>/dev/null || true
  rm -f "$STATE_DIR/daemon.pid"
}

merge_programs_json() {
  [[ -f "$PROGRAMS_SRC" ]] || { say "  - no programs.json snippet, skipping"; return 0; }
  REPO_PROGRAMS="$PROGRAMS_SRC" DST="$PROGRAMS_DST" BACKUP="$BACKUP_DST" node -e '
    const fs = require("node:fs")
    const dst = process.env.DST
    const backup = process.env.BACKUP
    const ours = JSON.parse(fs.readFileSync(process.env.REPO_PROGRAMS, "utf8"))
    let current = {}
    if (fs.existsSync(dst)) {
      try {
        current = JSON.parse(fs.readFileSync(dst, "utf8"))
      } catch (error) {
        console.error(`  ! existing ${dst} is not valid JSON (${error.message}); not touching it`)
        process.exit(0)
      }
      fs.copyFileSync(dst, backup)
    }
    fs.mkdirSync(require("node:path").dirname(dst), { recursive: true })
    const merged = { ...current }
    const programs = { ...(current.programs || {}) }
    for (const [key, entry] of Object.entries(ours.programs || {})) {
      const existing = programs[key]
      programs[key] = existing && typeof existing === "object" ? { ...existing, ...entry } : entry
    }
    merged.programs = programs
    for (const [key, value] of Object.entries(ours)) if (key !== "programs") merged[key] = merged[key] ?? value
    const tmp = dst + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n")
    fs.renameSync(tmp, dst)
    console.log(`  + programs.json entries: ${Object.keys(ours.programs || {}).join(", ")}`)
  '
}

install_files() {
  need node; need hc
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number)
    if (major < 22 || (major === 22 && minor < 15)) {
      console.error(`dsh-herdr needs Node.js >= 22.15 (node:zlib zstd); found ${process.version}`)
      process.exit(1)
    }
  '
  say "Installing dsh-herdr:"
  install -d "$HOME_DIR/.local/bin" "$APP_HOME/mods" "$STATE_DIR"
  install -m 0755 "$BIN_SRC" "$BIN_DST"
  say "  + $BIN_DST"

  if [[ -x "$REPO_DIR/app/install.sh" ]]; then
    say "  · herdr-app side (mod + programs.json), via app/install.sh:"
    "$REPO_DIR/app/install.sh" install | sed 's/^/    /'
  else
    [ -d "$MOD_SRC" ] || die "missing monitor mod source: $MOD_SRC"
    rm -rf "$MOD_DST"
    cp -r "$MOD_SRC" "$MOD_DST"
    say "  + $MOD_DST"
    if [[ -f "$PROGRAMS_DST" ]]; then say "  · existing programs.json backed up to $BACKUP_DST"; fi
    merge_programs_json
  fi

  # A stable PATH for the icon + launcher.
  case ":$PATH:" in
    *":$HOME_DIR/.local/bin:"*) : ;;
    *) say "  ! note: $HOME_DIR/.local/bin is not on PATH; add it so 'dsh-herdr' and the agent-menu entry work" ;;
  esac
}

install_systemd() {
  if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
    say "  ! systemd --user is not available on this system (macOS uses launchd);"
    say "    start the reporter once with:  $BIN_DST daemon"
    return 0
  fi
  install -d "$UNIT_DIR"
  cat > "$UNIT_DST" <<EOF
[Unit]
Description=dsh-herdr: keep DeepSeek Harness panes attached in Herdr
After=default.target

[Service]
Type=simple
Environment=PATH=$HOME_DIR/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$BIN_DST daemon --quiet
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now dsh-herdr-daemon.service
  say "  + systemd --user unit enabled: dsh-herdr-daemon.service"
}

start_now() {
  need hc
  if pgrep -f "dsh-herdr daemon" >/dev/null 2>&1; then
    say "  · daemon already running"
    return 0
  fi
  hc run --bg --rm --no-parent --no-notify --name dsh-herdr-daemon --cwd "$HOME_DIR" \
    "$BIN_DST" daemon --quiet >/dev/null 2>&1 || true
  say "  + reporter daemon started in herdr-core (log: $STATE_DIR/daemon.log)"
}

install_plugin() {
  if [[ -x "$PLUGIN_DIR/install.sh" ]]; then
    say "Installing the native DSH host plugin (optional path):"
    "$PLUGIN_DIR/install.sh"
  else
    say "  · host plugin installer not present (plugin/install.sh); skipping"
  fi
}

uninstall() {
  say "Removing dsh-herdr:"
  systemctl --user disable --now dsh-herdr-daemon.service 2>/dev/null || true
  rm -f "$UNIT_DST"
  stop_reporters
  rm -f "$BIN_DST"
  if [[ -x "$REPO_DIR/app/install.sh" ]]; then
    "$REPO_DIR/app/install.sh" --uninstall | sed 's/^/  /' || true
  fi
  rm -rf "$MOD_DST"
  if [[ -f "$BACKUP_DST" ]]; then
    mv "$BACKUP_DST" "$PROGRAMS_DST"
    say "  · programs.json restored from backup"
  else
    PROGRAMS_DST="$PROGRAMS_DST" node -e '
      const fs = require("node:fs")
      const path = process.env.PROGRAMS_DST
      if (!fs.existsSync(path)) process.exit(0)
      let doc
      try { doc = JSON.parse(fs.readFileSync(path, "utf8")) } catch { process.exit(0) }
      const programs = doc.programs || {}
      for (const key of ["dsh-tui", "dsh-herdr"]) delete programs[key]
      if (Object.keys(programs).length) doc.programs = programs
      else delete doc.programs
      fs.writeFileSync(path, JSON.stringify(doc, null, 2) + "\n")
    '
  fi
  say "  + removed files; DSH and Herdr themselves were not touched"
}

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --uninstall) uninstall; exit 0 ;;
esac

say "dsh-herdr installer"
say ""
install_files
DO_PLUGIN=0; DO_START=0; DO_SYSTEMD=0
for arg in "$@"; do
  case "$arg" in
    --plugin) DO_PLUGIN=1 ;;
    --start) DO_START=1 ;;
    --systemd) DO_SYSTEMD=1 ;;
    *) die "unknown option: $arg (see --help)" ;;
  esac
done
[[ $DO_PLUGIN -eq 1 ]] && install_plugin
[[ $DO_SYSTEMD -eq 1 ]] && install_systemd
[[ $DO_START -eq 1 ]] && start_now

say ""
say "Verify:"
if "${BIN_DST}" watch --once --no-osc >/dev/null 2>&1; then
  say "  ✓ dsh-herdr reads DSH sessions"
else
  say "  ! dsh-herdr could not read DSH sessions yet (is dsh installed for $HOME_DIR?)"
fi
if command -v hc >/dev/null 2>&1; then
  if hc ls >/dev/null 2>&1; then say "  ✓ herdr-core reachable"; else say "  ! herdr-core not reachable (start Herdr)"; fi
else
  say "  ! hc not on PATH"
fi
[[ -f "$PROGRAMS_DST" ]] && say "  ✓ $PROGRAMS_DST"
say ""
say "Next:"
say "  • A dsh web host that runs in a Herdr pane should appear as a \"DeepSeek Harness\" agent."
say "    If it was already running before this install, run once: dsh-herdr daemon   (or rerun with --start)"
say "  • Start a live monitor pane where you like:  hc run --bg --name dsh dsh-herdr watch"
say "  • Open the DSH panel in Herdr:  herdr-app do mod.open --name dsh-monitor"
say "  • Details, architecture and troubleshooting: $REPO_DIR/README.md"
