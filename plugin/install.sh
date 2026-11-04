#!/usr/bin/env bash
# Install the herdr-status DSH host plugin into a DeepSeek Harness profile.
#
#   plugin/install.sh                 # install into a NEW profile named "herdr"
#   plugin/install.sh --profile herdr
#   plugin/install.sh --rollback      # remove the plugin again (profile stays)
#   plugin/install.sh --uninstall     # alias for --rollback
#   plugin/install.sh --dry-run
#
# The script never touches your live `web` profile: the default target
# is a separate profile named `herdr`. Installing into `web` requires an explicit
# `--allow-web` and is not recommended while your session is live
# (a profile change needs a host restart to take effect).
#
# Requirements: `dsh` on PATH (or DSH_BIN), node, pnpm (invoked by `dsh plugin`).
set -euo pipefail

PROFILE="herdr"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_BIN="${DSH_BIN:-dsh}"
DRY_RUN=0
ROLLBACK=0
ALLOW_WEB=0
WEB_BUNDLE="@deepseek-ai/dsh-web-app"
PLUGIN_NAME="dsh-plugin-herdr"

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile needs a name}"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --rollback|--uninstall) ROLLBACK=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-web) ALLOW_WEB=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$PROFILE" == "web" && "$ALLOW_WEB" -ne 1 ]]; then
  echo "install.sh: refusing to modify the live 'web' profile (use --profile herdr, or pass --allow-web explicitly)." >&2
  exit 2
fi

if ! command -v "$DSH_BIN" >/dev/null 2>&1; then
  echo "install.sh: dsh not found on PATH (set DSH_BIN=/path/to/dsh)" >&2
  exit 2
fi

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

run() {
  echo "+ $*"
  if [[ "$DRY_RUN" -ne 1 ]]; then "$@"; fi
}

if [[ "$ROLLBACK" -eq 1 ]]; then
  run "$DSH_BIN" plugin --profile "$PROFILE" remove "$PLUGIN_NAME"
  echo
  echo "Uninstalled: $PLUGIN_NAME removed from profile '$PROFILE' (profile directory kept at $PROFILE_DIR)."
  echo "Restart the host for the removal to take effect."
  exit 0
fi

# 1) Initialize the profile (a no-op on an existing profile) and install the
#    plugin package. Because the package declares dsh.bundle.patch, the profile
#    bundle list gains it automatically (profile plugin reconciliation).
run "$DSH_BIN" plugin --profile "$PROFILE" add "$PLUGIN_DIR"

# 2) A fresh non-shipped profile template contains only @deepseek-ai/dsh-base,
#    which has no web app; append the shipped web-app bundle when missing so
#    `dsh --profile <name> --port <port>` serves the browser UI with sessions.
if [[ "$DRY_RUN" -ne 1 ]]; then
  PROFILE_MANIFEST="$PROFILE_DIR/package.json" node - "$PROFILE_DIR" "$WEB_BUNDLE" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [profileDir, webBundle] = process.argv.slice(2)
const manifestPath = path.join(profileDir, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
const bundles = manifest.dsh.profile.bundles ?? (manifest.dsh.profile.bundles = [])
if (!bundles.includes(webBundle)) {
  bundles.push(webBundle)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`+ added ${webBundle} to ${manifestPath}`)
} else {
  console.log(`= ${webBundle} already in ${manifestPath}`)
}
NODE
else
  echo "+ ensure $WEB_BUNDLE is in $PROFILE_DIR/package.json dsh.profile.bundles"
fi

BANNER=""
if [[ "$DRY_RUN" -eq 1 ]]; then
  BANNER="DRY RUN — would install $PLUGIN_NAME into profile '$PROFILE' ($PROFILE_DIR)."
else
  BANNER="Installed $PLUGIN_NAME into profile '$PROFILE' ($PROFILE_DIR)."
fi

cat <<EOF

$BANNER

Activate (the running host was started before the install, so it must be
restarted for the plugin to load):

  1. In the Herdr pane that runs the DSH host, stop it (Ctrl-C).
  2. Restart it there, e.g.:   dsh --profile $PROFILE --no-open   (add --port 3181 if 3080 is taken)
  3. In the browser, reopen the printed tokenized URL. Sessions persist.
  4. In another shell verify:  hc get <pane-address>   -> status app=dsh-tui, state=idle
     or poll the state file:   ~/.local/state/dsh-herdr/agents.json

Notes
  - OSC 7501 is written to the host's stdout (its Herdr pty); Herdr shows
    "DeepSeek Harness" because the plugin reports app=dsh-tui.
  - State file: ~/.local/state/dsh-herdr/agents.json (override: DSH_HERDR_STATE=/abs/file.json).
  - Disable without uninstalling: start the host with DSH_HERDR_DISABLE=1.
  - Uninstall: plugin/install.sh --profile $PROFILE --uninstall
    (or --rollback; the profile directory and its sessions stay)
EOF
