#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CONNECTOR_ENTRY="$ROOT_DIR/build/connector/index.js"

cd "$ROOT_DIR"

command -v node >/dev/null 2>&1 || {
  printf 'Node.js is required to start the connector.\n' >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  printf 'npm is required to build the connector.\n' >&2
  exit 1
}

# The service is restarted after repository updates. Building here keeps the
# long-running process on the same source revision as the relay checkout.
npm run build:node --silent

[ -f "$CONNECTOR_ENTRY" ] || {
  printf 'Compiled connector is missing: %s\n' "$CONNECTOR_ENTRY" >&2
  exit 1
}

exec node "$CONNECTOR_ENTRY"
