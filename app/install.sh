#!/usr/bin/env bash
# Install (or remove) the DSH monitor panel and the DeepSeek Harness program
# entries in the herdr-app home. Idempotent and additive:
#   - only mods/dsh-monitor/ is replaced (other mods are never touched)
#   - programs.json is merged; every existing entry and field is preserved
#   - nothing outside ~/.config/herdr-app (or $HERDR_APP_HOME) is written
#
# usage: install.sh [--uninstall]
set -euo pipefail

self="${BASH_SOURCE[0]}"
if command -v node >/dev/null 2>&1; then
  here=$(node -e 'console.log(require("node:path").dirname(require("node:fs").realpathSync(process.argv[1])))' "$self")
else
  here=$(cd "$(dirname "$self")" && pwd -P)
fi
app_home=${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}
mod_dst=$app_home/mods/dsh-monitor
programs=$app_home/programs.json
mode=${1:-install}

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

[[ -d $app_home ]] || die "no herdr-app home at $app_home (start herdr-app once first)"
command -v node >/dev/null || die "node is required (programs.json merge and the reporter)"

case $mode in
install)
  command -v herdr-app >/dev/null || die "herdr-app is not on PATH"

  # 1. The mod folder. Ours only; every other mod stays as it is.
  mkdir -p "$app_home/mods"
  rm -rf -- "$mod_dst"
  cp -r -- "$here/mods/dsh-monitor" "$mod_dst"
  echo "installed $mod_dst"

  # 2. programs.json: our entries fill gaps; your values win.
  node "$here/programs.mjs" install "$programs" "$here/programs.json"

  # 3. Verify: the app must accept the mod, and the program table must load.
  herdr-app check "$mod_dst"
  if [[ -e $app_home/programs.error ]]; then
    die "herdr-app rejected programs.json: $(cat "$app_home/programs.error")"
  fi
  if herdr-app status 2>/dev/null | grep -q '"errors": *\[\]'; then
    echo "herdr-app status: no errors"
  else
    echo "warning: herdr-app status reports errors; run: herdr-app status" >&2
  fi

  cat <<'EOF'

Installed. Show the panel:
  herdr-app do mod.open --name dsh-monitor                      # floating panel (run again/Esc closes)
  herdr-app do pane.split --direction right --mod dsh-monitor   # docked beside the focused pane
Feed it (installed by the DSH integration installer; must be on PATH):
  dsh-herdr daemon        # keeps every dsh web pane reporting (or: dsh-herdr watch)
EOF
  ;;
--uninstall | uninstall)
  if [[ -f $programs ]]; then
    node "$here/programs.mjs" uninstall "$programs"
  fi
  rm -rf -- "$mod_dst"
  echo "removed $mod_dst"
  echo "Close any open monitor pane/overlay first: a docked pane stays as an empty block after the folder is gone."
  ;;
*)
  die "usage: install.sh [--uninstall]"
  ;;
esac
