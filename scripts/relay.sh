#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE="$ROOT_DIR/.env"

cd "$ROOT_DIR"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_compose() {
  command -v docker >/dev/null 2>&1 || die 'Docker is not installed.'
  docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is not available.'
}

connector_token() {
  [ -f "$ENV_FILE" ] || die '.env does not exist. Run ./scripts/relay.sh setup first.'
  token=$(sed -n 's/^BRIDGE_CONNECTOR_TOKEN=//p' "$ENV_FILE" | tail -n 1)
  [ "${#token}" -ge 32 ] || die 'BRIDGE_CONNECTOR_TOKEN is missing or too short in .env.'
  printf '%s' "$token"
}

ensure_environment() {
  if [ ! -e "$ENV_FILE" ]; then
    umask 077
    token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    [ "${#token}" -eq 64 ] || die 'Could not generate the connector token.'
    {
      printf 'BRIDGE_CONNECTOR_TOKEN=%s\n' "$token"
      printf 'CODEX_UI_LANGUAGE=%s\n' "${CODEX_UI_LANGUAGE:-zh-CN}"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    printf 'Created %s with a new connector token.\n' "$ENV_FILE"
  elif [ ! -f "$ENV_FILE" ]; then
    die '.env exists but is not a regular file.'
  fi
  connector_token >/dev/null
}

relay_health() {
  docker compose exec -T bridge node -e \
    "fetch('http://127.0.0.1:3300/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
}

wait_for_health() {
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if relay_health >/dev/null 2>&1; then
      printf 'Relay is healthy.\n'
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  docker compose ps >&2 || true
  die 'Relay did not become healthy within 30 seconds.'
}

run_admin() {
  require_compose
  docker compose exec bridge node build/server/device-admin.js "$@"
}

show_help() {
  cat <<'EOF'
Usage: ./scripts/relay.sh <command>

  setup              Create .env when needed, build, start, and verify the relay
  status             Show containers and verify relay health
  token              Print the connector token for local connector installation
  approve            Review and approve a pending connector
  pending            List pending devices
  pair <public-url>  Create a ten-minute, single-use browser pairing link
  devices            List approved devices
  revoke             Select and revoke an approved device
  update             Pull main, rebuild, restart, and verify the relay
  help               Show this help
EOF
}

command_name=${1:-help}
if [ "$#" -gt 0 ]; then shift; fi

case "$command_name" in
  setup)
    [ "$#" -eq 0 ] || die 'setup does not accept arguments.'
    require_compose
    ensure_environment
    docker compose up -d --build
    wait_for_health
    printf 'Next: install the local connector, then run ./scripts/relay.sh approve and ./scripts/relay.sh pair <public-url>.\n'
    ;;
  status)
    [ "$#" -eq 0 ] || die 'status does not accept arguments.'
    require_compose
    docker compose ps
    relay_health
    printf 'Relay is healthy.\n'
    ;;
  token)
    [ "$#" -eq 0 ] || die 'token does not accept arguments.'
    printf 'This secret authenticates the connector. Do not paste it into chats, issues, screenshots, or logs.\n' >&2
    connector_token
    printf '\n'
    ;;
  approve)
    [ "$#" -eq 0 ] || die 'approve does not accept arguments.'
    run_admin
    ;;
  pending)
    [ "$#" -eq 0 ] || die 'pending does not accept arguments.'
    run_admin list
    ;;
  pair)
    [ "$#" -eq 1 ] || die 'Usage: ./scripts/relay.sh pair https://codex.example.com'
    run_admin pair "$1"
    ;;
  devices)
    [ "$#" -eq 0 ] || die 'devices does not accept arguments.'
    run_admin list-approved
    ;;
  revoke)
    [ "$#" -eq 0 ] || die 'revoke does not accept arguments.'
    run_admin revoke
    ;;
  update)
    [ "$#" -eq 0 ] || die 'update does not accept arguments.'
    command -v git >/dev/null 2>&1 || die 'Git is not installed.'
    [ -z "$(git status --porcelain --untracked-files=normal)" ] \
      || die 'The checkout has local changes. Review them before updating.'
    git pull --ff-only origin main
    require_compose
    ensure_environment
    docker compose up -d --build
    wait_for_health
    ;;
  help|-h|--help)
    show_help
    ;;
  *)
    show_help >&2
    die "Unknown command: $command_name"
    ;;
esac
