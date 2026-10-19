FROM rust:1-bookworm AS bundle
WORKDIR /app/tauri-app
# Same system libraries as tauri-app/README.md (Debian/Ubuntu row).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev \
      libayatana-appindicator3-dev librsvg2-dev pkg-config libdbus-1-dev \
      curl ca-certificates rsync rclone \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
# /app/tauri-app is bind-mounted; cargo state lives in named volumes so the
# container can run as the host user (uid 1000) and leave no root-owned files.
ENV CARGO_HOME=/cargo \
    CARGO_TARGET_DIR=/target \
    HOME=/tmp
RUN mkdir -p /cargo /target /out && chown 1000:1000 /cargo /target /out
# AppImage needs FUSE, which containers lack; .deb is the portable bundle here.
CMD ["sh", "-c", "npm ci && npm run tauri build -- --bundles deb && cp -r /target/release/bundle/deb/. /out/"]
