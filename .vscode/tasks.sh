#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --prefix tauri-app
npm run build --prefix tauri-app
docker compose up -d --build server

echo "[backurau] Waiting for server to be healthy (first run compiles axum)..."
for attempt in $(seq 1 180); do
  if docker compose exec -T server curl -fs http://127.0.0.1:8787/health >/dev/null; then
    break
  fi
  if [ "$attempt" = 180 ]; then
    docker compose logs --tail=60 server
    exit 1
  fi
  sleep 2
done

echo "[backurau] Opening authenticated Backurau in Google Chrome"
sleep 1

# Detached so the task exits and the agent tabs (see tasks.json "Dev") can start
__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia __VK_LAYER_NV_optimus=NVIDIA_only google-chrome --profile-directory=Default --app=https://backurau.local &>/dev/null &

docker compose logs -f
