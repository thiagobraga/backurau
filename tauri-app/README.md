# Backurau — native desktop build (Tauri v2)

The UI wrapped in a **real native window with a real Rust backend**. The window runs
frameless (`decorations: false`) with the custom Backurau titlebar — minimize / maximize / close and
titlebar-dragging go straight to the Rust window handle.

## Prerequisites (one-time)

**1. Rust**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**2. WebKit/GTK system deps** (Tauri's webview) — pick your distro:

| Distro | Command |
|---|---|
| Debian / Ubuntu | `sudo apt update && sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` |
| Fedora | `sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel` |
| Arch | `sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file` |

**3. Tauri CLI** — either:
```bash
cd tauri-app && npm install      # npm path
# or with no node at all:
cargo install tauri-cli --locked
```

## Run it (dev)

```bash
cd tauri-app
npm run tauri dev        # or: cargo tauri dev
```

First compile pulls ~450 crates and takes a few minutes; every run after that is quick.

## Production build

```bash
npm run tauri build      # or: cargo tauri build
```
→ `.deb` / `.rpm` / AppImage land in `src-tauri/target/release/bundle/`.

## What's real in this build

Everything. See the root README for the command list. Try it: **Sources → Add folder**, then
**Overview → Back up now**; the archive lands in the destination shown in **Storage**.

## Troubleshooting

- **`failed to run custom build command for gdk-sys` / "Package gdk-3.0 was not found"** —
  the GTK/WebKit dev packages aren't installed. This is the #1 first-build error. Run
  `./check-deps.sh` to see exactly what's missing, then (Debian/Ubuntu):
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev pkg-config
  ```
  `libwebkit2gtk-4.1-dev` pulls in `libgtk-3-dev`, which is what provides `gdk-3.0.pc`. Then just
  rerun `npm run tauri dev` — cargo resumes where it stopped, no need to clean.
  Very old distros (Debian 11, Ubuntu 20.04) only ship WebKitGTK 4.0, which Tauri v2 can't use.
- **`webkit2gtk-4.1` not found**: Tauri v2 needs the 4.1 webkit API — your distro may name the dev
  package differently (see table above; 4.0 is not enough).
- **`tauri` command not found**: add `~/.cargo/bin` to PATH or use the npm script instead.
