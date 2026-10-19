#!/usr/bin/env bash
# Install, start, stop or remove Backurau's web service as a systemd user unit.
#
#   scripts/service-linux.sh install [path/to/backurau-server]   (default: server/target/release/backurau-server)
#   scripts/service-linux.sh uninstall
#   scripts/service-linux.sh status
#
# The unit stores no secret. The access token is written to the data directory on
# first start and printed to the journal:  journalctl --user -u backurau -n 20
# Listens on 127.0.0.1:8787 unless BIND and PORT are set in the environment at install time.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT="backurau.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT"
BIND="${BIND:-127.0.0.1}"
PORT="${PORT:-8787}"

command -v systemctl >/dev/null || { echo "systemctl not found: this script needs systemd (Linux)." >&2; exit 1; }

install() {
  local bin="${1:-$ROOT/server/target/release/backurau-server}"
  [ -x "$bin" ] || { echo "Server binary not found or not executable: $bin" >&2; echo "Build it: cargo build --release --manifest-path server/Cargo.toml" >&2; exit 1; }
  bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"

  case "$BIND" in
    127.0.0.1|localhost|::1) ;;
    *) [ "${BACKURAU_ALLOW_REMOTE:-}" = "1" ] || { echo "Refusing to listen on $BIND without BACKURAU_ALLOW_REMOTE=1" >&2; exit 1; } ;;
  esac

  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Backurau backup service
After=network-online.target

[Service]
Type=simple
ExecStart=$bin
Environment=BIND=$BIND
Environment=PORT=$PORT
Environment=BACKURAU_ALLOW_REMOTE=${BACKURAU_ALLOW_REMOTE:-0}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT"
  echo "[backurau] Service running at http://$BIND:$PORT/"
  echo "[backurau] Access token: journalctl --user -u backurau -n 20"
  echo "[backurau] Keep it running after logout: sudo loginctl enable-linger \"$USER\""
}

uninstall() {
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl --user daemon-reload
  echo "[backurau] Service removed. Plans, runs and saved versions were kept in the data directory."
}

case "${1:-}" in
  install) shift; install "$@" ;;
  uninstall) uninstall ;;
  status) systemctl --user status "$UNIT" --no-pager ;;
  *) sed -n '2,8p' "$0" >&2; exit 2 ;;
esac
