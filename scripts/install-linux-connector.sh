#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SERVICE_NAME=codex-anywhere-connector.service
DEVICE_ID=ecs
DEVICE_LABEL='ECS · 24x7'
BRIDGE_URL=ws://127.0.0.1:3300/ws
SERVICE_USER=${SUDO_USER:-$(id -un)}
NETWORK_ACCESS=0
ALLOWED_ROOTS=
NO_START=0

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

show_help() {
  cat <<'EOF'
Usage: sudo ./scripts/install-linux-connector.sh [options]

  --device-id <id>       Stable relay route (default: ecs)
  --label <name>         Human-readable connector label
  --bridge-url <url>     Relay WebSocket URL (default: ws://127.0.0.1:3300/ws)
  --user <name>          Linux account that owns Codex login and workspaces
  --allowed-root <path>  Allowed workspace root; repeat for multiple roots
  --enable-network       Allow connector-owned Codex turns to request network access
  --no-start             Install without enabling or starting the service
  -h, --help             Show this help

When the relay .env exists in this checkout, its connector token is reused
without printing it. Otherwise BRIDGE_CONNECTOR_TOKEN must be set in the
installer environment.
EOF
}

append_root() {
  root=$1
  [ -n "$root" ] || die 'Allowed roots must not be empty.'
  has_line_break "$root" && die 'Allowed roots must stay on one line.'
  case "$root" in
    *:*) die 'Allowed roots must not contain a colon.' ;;
  esac
  if [ -n "$ALLOWED_ROOTS" ]; then
    ALLOWED_ROOTS="$ALLOWED_ROOTS:$root"
  else
    ALLOWED_ROOTS=$root
  fi
}

has_line_break() {
  carriage_return=$(printf '\r')
  case "$1" in
    *"$carriage_return"*|*'
'*) return 0 ;;
    *) return 1 ;;
  esac
}

run_as_service_user() {
  if [ "$SERVICE_USER" = "$(id -un)" ]; then
    "$@"
  else
    runuser -u "$SERVICE_USER" -- "$@"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --device-id) [ "$#" -ge 2 ] || die '--device-id requires a value.'; DEVICE_ID=$2; shift 2 ;;
    --label) [ "$#" -ge 2 ] || die '--label requires a value.'; DEVICE_LABEL=$2; shift 2 ;;
    --bridge-url) [ "$#" -ge 2 ] || die '--bridge-url requires a value.'; BRIDGE_URL=$2; shift 2 ;;
    --user) [ "$#" -ge 2 ] || die '--user requires a value.'; SERVICE_USER=$2; shift 2 ;;
    --allowed-root) [ "$#" -ge 2 ] || die '--allowed-root requires a value.'; append_root "$2"; shift 2 ;;
    --enable-network) NETWORK_ACCESS=1; shift ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) show_help; exit 0 ;;
    *) show_help >&2; die "Unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die 'Run this installer with sudo or as root.'
command -v systemctl >/dev/null 2>&1 || die 'systemd is required.'
command -v getent >/dev/null 2>&1 || die 'getent is required.'
command -v node >/dev/null 2>&1 || die 'Node.js 22 or newer is required.'
command -v npm >/dev/null 2>&1 || die 'npm is required.'
command -v codex >/dev/null 2>&1 || die 'Codex CLI is required.'
[ "$SERVICE_USER" = "$(id -un)" ] || command -v runuser >/dev/null 2>&1 \
  || die 'runuser is required when installing for another Linux account.'

case "$DEVICE_ID" in
  ''|*[!A-Za-z0-9._-]*) die 'Device id may contain only letters, numbers, dot, underscore, and dash.' ;;
esac
case "$BRIDGE_URL" in
  ws://*|wss://*) ;;
  *) die 'Bridge URL must use ws:// or wss://.' ;;
esac
case "$BRIDGE_URL" in
  *'?'*|*'#'*|*@*) die 'Bridge URL must not contain credentials, a query, or a fragment.' ;;
esac
has_line_break "$DEVICE_LABEL" && die 'Connector label must stay on one line.'
has_line_break "$BRIDGE_URL" && die 'Bridge URL must stay on one line.'

USER_ENTRY=$(getent passwd "$SERVICE_USER") || die "Linux user does not exist: $SERVICE_USER"
USER_HOME=$(printf '%s' "$USER_ENTRY" | cut -d: -f6)
[ -n "$USER_HOME" ] || die "Home directory is unavailable for $SERVICE_USER."
if [ -z "$ALLOWED_ROOTS" ]; then
  append_root "$USER_HOME/codex-workspaces"
fi

OLD_IFS=$IFS
IFS=:
for root in $ALLOWED_ROOTS; do
  mkdir -p "$root"
  chown "$SERVICE_USER" "$root"
done
IFS=$OLD_IFS

TOKEN=${BRIDGE_CONNECTOR_TOKEN:-}
if [ -z "$TOKEN" ] && [ -f "$ROOT_DIR/.env" ]; then
  TOKEN=$(sed -n 's/^BRIDGE_CONNECTOR_TOKEN=//p' "$ROOT_DIR/.env" | tail -n 1)
fi
[ "${#TOKEN}" -ge 32 ] || die 'A connector token of at least 32 characters is required.'

NODE_BIN=$(command -v node)
NPM_BIN=$(command -v npm)
CODEX_BIN=$(command -v codex)
NODE_MAJOR=$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 22 ] || die 'Node.js 22 or newer is required.'
run_as_service_user test -x "$NODE_BIN" || die "Node.js is not executable by $SERVICE_USER."
run_as_service_user test -x "$NPM_BIN" || die "npm is not executable by $SERVICE_USER."
run_as_service_user test -x "$CODEX_BIN" || die "Codex CLI is not executable by $SERVICE_USER."
run_as_service_user env HOME="$USER_HOME" "$CODEX_BIN" login status >/dev/null 2>&1 \
  || die "Codex CLI is not logged in for $SERVICE_USER."
run_as_service_user test -w "$ROOT_DIR" \
  || die "The checkout must be writable by $SERVICE_USER so connector updates can rebuild it."
STATE_DIR="$USER_HOME/.codex-anywhere"
IDENTITY_FILE="$STATE_DIR/connector-$DEVICE_ID-identity.json"
CONFIG_DIR=/etc/codex-anywhere
ENV_FILE="$CONFIG_DIR/connector.env"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"

mkdir -p "$STATE_DIR" "$CONFIG_DIR"
chown "$SERVICE_USER" "$STATE_DIR"
chmod 700 "$STATE_DIR" "$CONFIG_DIR"
umask 077

escape_environment_value() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

{
  printf 'BRIDGE_CONNECTOR_TOKEN="%s"\n' "$(escape_environment_value "$TOKEN")"
  printf 'BRIDGE_URL="%s"\n' "$(escape_environment_value "$BRIDGE_URL")"
  printf 'BRIDGE_DEVICE_ID="%s"\n' "$(escape_environment_value "$DEVICE_ID")"
  printf 'BRIDGE_DEVICE_LABEL="%s"\n' "$(escape_environment_value "$DEVICE_LABEL")"
  printf 'BRIDGE_DEVICE_IDENTITY_FILE="%s"\n' "$(escape_environment_value "$IDENTITY_FILE")"
  printf 'CODEX_BIN="%s"\n' "$(escape_environment_value "$CODEX_BIN")"
  printf 'CODEX_ALLOWED_ROOTS="%s"\n' "$(escape_environment_value "$ALLOWED_ROOTS")"
  printf 'CODEX_CONNECTOR_MODE="headless"\n'
  printf 'CODEX_NETWORK_ACCESS="%s"\n' "$NETWORK_ACCESS"
  printf 'CODEX_ALLOW_ANY_FILE_DOWNLOAD="0"\n'
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Codex Anywhere headless connector
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory="$ROOT_DIR"
Environment="HOME=$USER_HOME"
Environment="PATH=$(dirname "$NODE_BIN"):$(dirname "$NPM_BIN"):$(dirname "$CODEX_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
EnvironmentFile=$ENV_FILE
ExecStart="$ROOT_DIR/scripts/start-connector.sh"
Restart=always
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$SERVICE_FILE"

cd "$ROOT_DIR"
run_as_service_user env HOME="$USER_HOME" "$NPM_BIN" ci
run_as_service_user env HOME="$USER_HOME" "$NPM_BIN" run build:node
systemctl daemon-reload

if [ "$NO_START" -eq 0 ]; then
  systemctl enable --now "$SERVICE_NAME"
  sleep 1
  systemctl is-active --quiet "$SERVICE_NAME" || {
    journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
    die 'Connector service did not become active.'
  }
  printf 'Connector service is active as %s with route %s.\n' "$SERVICE_USER" "$DEVICE_ID"
  printf 'Approve the pending connector with ./scripts/relay.sh approve.\n'
else
  printf 'Connector service installed but not started.\n'
fi
