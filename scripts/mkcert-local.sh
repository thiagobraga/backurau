#!/bin/bash
# Register backurau.local: /etc/hosts entry + mkcert SAN in the shared Traefik certs folder.
# Existing SANs in the cert are kept, so other projects keep working.
set -euo pipefail

HOST="${APP_SUBDOMAIN:-backurau}.local"
CERTS="${TRAEFIK_CERTS:-/p/projects/proxy/certs}"
CERT="$CERTS/localhost.pem"
KEY="$CERTS/localhost-key.pem"

command -v mkcert >/dev/null || { echo "mkcert not found (see /p/projects/proxy/README.md)" >&2; exit 1; }

if ! grep -qE "^[^#]*[[:space:]]$HOST([[:space:]]|$)" /etc/hosts; then
  echo "127.0.0.1  $HOST" | sudo tee -a /etc/hosts >/dev/null
  echo "[mkcert-local] added $HOST to /etc/hosts"
fi

names=()
if [ -f "$CERT" ]; then
  while read -r n; do names+=("$n"); done < <(
    openssl x509 -in "$CERT" -noout -ext subjectAltName |
      tr ',' '\n' | sed -nE 's/^ *(DNS:|IP Address:)//p' | awk '!seen[$0]++'
  )
fi

if printf '%s\n' "${names[@]}" | grep -qxF "$HOST"; then
  echo "[mkcert-local] $HOST already in $CERT"
  exit 0
fi

if [ -f "$CERT" ]; then
  backup="$CERTS/.backup.$(date +%s)"
  mkdir -p "$backup"
  cp "$CERT" "$KEY" "$backup/"
fi

mkcert -install
mkcert -cert-file "$CERT" -key-file "$KEY" "${names[@]}" "$HOST"
echo "[mkcert-local] $HOST added to $CERT (Traefik reloads dynamic/tls.yml on its own; restart it if the old cert is still served)"
