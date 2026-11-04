#!/usr/bin/env bash
# Runs the checks that work on any machine: static syntax + fixture smoke tests.
# The full end-to-end tests that need a real Herdr core live in monitor/tests/
# (see monitor/TESTING.md).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/tests/check-syntax.sh"
node "$ROOT/tests/smoke.mjs"
node --test "$ROOT"/tests/*.test.mjs
