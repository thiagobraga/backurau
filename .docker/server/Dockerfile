FROM rust:1-bookworm AS development
WORKDIR /app/server
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl pkg-config libssl-dev libdbus-1-dev rsync rclone ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# /app/server and ../tauri-app/ui are bind-mounted, so only the toolchain lives
# in the image. CARGO_HOME and CARGO_TARGET_DIR point at named volumes so the
# container can run as the host user (uid 1000) and keep builds out of the tree.
ENV CARGO_HOME=/cargo \
    CARGO_TARGET_DIR=/target
RUN mkdir -p /cargo /target /data && chown 1000:1000 /cargo /target /data
EXPOSE 8787
CMD ["cargo", "run", "--release"]
