#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -d /mnt/models/fleet-offload/tmp ]]; then
  export TMPDIR="/mnt/models/fleet-offload/tmp/kanpai-0cc2a7723b01"
else
  export TMPDIR="${PWD}/.test-tmp"
fi
mkdir -p "$TMPDIR" coverage/node
export CHROME_BIN="${CHROME_BIN:-$(command -v google-chrome || command -v chromium || true)}"
command -v node
node --version
if [[ -z "$CHROME_BIN" ]]; then echo 'Chrome/Chromium required' >&2; exit 1; fi
"$CHROME_BIN" --version
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw Error("Node >=22 required")'
NODE_V8_COVERAGE="$PWD/coverage/node" node --test --test-concurrency=1 tests/whole.test.mjs
