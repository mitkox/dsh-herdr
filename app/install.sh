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
  DST="$programs" SRC="$here/programs.json" node <<'JS'
    const fs = require("node:fs")
    const path = require("node:path")
    const target = process.env.DST
    const src = JSON.parse(fs.readFileSync(process.env.SRC, "utf8"))
    let base = {}
    if (fs.existsSync(target)) {
      try {
        base = JSON.parse(fs.readFileSync(target, "utf8"))
      } catch {
        const backup = `${target}.corrupt-${Date.now()}`
        fs.renameSync(target, backup)
        console.log(`warning: ${target} was not valid JSON; kept it as ${backup}`)
        base = {}
      }
    }
    if (typeof base !== "object" || base === null || Array.isArray(base)) base = {}
    const programs = typeof base.programs === "object" && base.programs !== null ? base.programs : (base.programs = {})
    for (const [key, entry] of Object.entries(src.programs || {})) {
      const existing = programs[key]
      programs[key] = { ...entry, ...(existing && typeof existing === "object" ? existing : {}) }
    }
    const data = JSON.stringify(base, null, 2) + "\n"
    const tmp = path.join(path.dirname(target) || ".", `.programs-${process.pid}.json`)
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, target)
    console.log(`merged program entries into ${target}: ${Object.keys(src.programs || {}).join(", ")}; existing entries kept`)
JS

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
    PROGRAMS="$programs" node <<'JS'
      const fs = require("node:fs")
      const path = require("node:path")
      const target = process.env.PROGRAMS
      let base
      try { base = JSON.parse(fs.readFileSync(target, "utf8")) } catch { process.exit(0) }
      if (base && typeof base === "object" && base.programs && typeof base.programs === "object") {
        for (const key of ["dsh-tui", "dsh-herdr"]) delete base.programs[key]
        if (Object.keys(base.programs).length === 0) delete base.programs
      }
      const tmp = path.join(path.dirname(target), `.programs-${process.pid}.json`)
      fs.writeFileSync(tmp, JSON.stringify(base, null, 2) + "\n")
      fs.renameSync(tmp, target)
      console.log(`removed dsh-tui/dsh-herdr entries from ${target}; the rest is untouched`)
JS
  fi
  rm -rf -- "$mod_dst"
  echo "removed $mod_dst"
  echo "Close any open monitor pane/overlay first: a docked pane stays as an empty block after the folder is gone."
  ;;
*)
  die "usage: install.sh [--uninstall]"
  ;;
esac
