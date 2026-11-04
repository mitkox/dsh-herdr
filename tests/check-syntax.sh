#!/usr/bin/env bash
# Syntax/static checks that need no Herdr or DSH installation.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "— shell syntax"
while IFS= read -r file; do
  bash -n "$file"
done < <(find "$ROOT" -name '*.sh' -not -path '*/node_modules/*' -not -path '*/.git/*')

echo "— JavaScript syntax"
node --check "$ROOT/bin/dsh-herdr"
for file in "$ROOT"/monitor/*.mjs "$ROOT"/monitor/lib/*.mjs "$ROOT"/monitor/tests/*.mjs "$ROOT"/app/*.mjs "$ROOT"/tests/*.mjs; do
  [ -f "$file" ] && node --check "$file"
done
[ -f "$ROOT/plugin/index.js" ] && node --check "$ROOT/plugin/index.js"
[ -f "$ROOT/plugin/test/drive.mjs" ] && node --check "$ROOT/plugin/test/drive.mjs"
node --check "$ROOT/tests/smoke.mjs"
# The Herdr panel mod is an ESM module the app loads; check a .mjs copy so node
# parses it as a module without needing the app's generated types.
tmp=$(mktemp -d)
cp "$ROOT/app/mods/dsh-monitor/main.js" "$tmp/main.mjs"
node --check "$tmp/main.mjs"
rm -rf "$tmp"

echo "— JSON"
node -e '
  const fs = require("node:fs")
  const path = require("node:path")
  const root = process.argv[1]
  for (const file of ["package.json", "app/programs.json", "plugin/package.json"]) {
    JSON.parse(fs.readFileSync(path.join(root, file), "utf8"))
  }
' "$ROOT"

if command -v python3 >/dev/null 2>&1; then
  echo "— Python syntax"
  python3 -m py_compile "$ROOT"/research/probes/*.py
  rm -rf "$ROOT"/research/probes/__pycache__
fi

echo "syntax checks passed"
