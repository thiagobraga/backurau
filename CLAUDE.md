# AI Agent Instructions

This file provides guidance to AI coding agents (Claude Code, Codex, Antigravity, OpenCode, GitHub Copilot, etc.) when working with code in this repository.

`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `.github/copilot-instructions.md` are symlinks to this single file - there is nothing to synchronize manually. Edit this file only; the other names stay in sync automatically because they resolve to the same inode. Do not replace any of them with a real file.

## Project

Backurau is a backup app for the user's own machine, styled after the film *Bacurau* (scorched earth, dust, aged paper, blood red). One Rust engine, two adapters, one React UI:

- `core/` - `backurau-core`: plans, comparison, runs, retained versions, restore, retention, scheduling, providers (local, rclone, rsync), OS credentials. All behaviour lives here.
- `tauri-app/src-tauri/` - desktop adapter (Tauri v2): one `api(method, args)` command plus `pick_folder`.
- `server/` - web adapter (axum): `POST /api/{method}`, loopback by default, bearer token + origin check. Also serves `tauri-app/ui`.
- `tauri-app/src/` - React 19 + Vite + TypeScript UI (Compare, Activity, Snapshots, Settings). `vite build` writes `tauri-app/ui`.

All data on screen is real; there is no demo data. Fixtures exist only in temporary test roots. The API contract is `.specs/IMPLEMENTATION.md`; product specs are in `PRODUCT.md` / `DESIGN.md`.

## Tool Name Equivalents

Different agents expose the same capability under different tool names. Read-before-edit discipline applies regardless of tool name: always read a file before modifying it, and grep for all callers before changing a function signature.

- Skill invocation: Claude Code `Skill` tool ≈ Gemini CLI `activate_skill` tool.

## Andrej Karpathy Engineering Principles

When starting development, apply Karpathy core engineering principles:

- **First-Principles Reasoning**: Understand root requirements and underlying systems before writing code.
- **Extreme Simplicity**: Build the simplest working solution; avoid premature abstractions and unneeded complexity.
- **Clean & Readable**: Write clear, self-explanatory code with zero fluff.
- **Deep Understanding**: Inspect exact definitions and trace dataflows before modifying existing logic.

## Quickstart

```bash
docker compose up -d --build server   # web service -> https://backurau.local (needs `npm run build --prefix tauri-app` first)
cd tauri-app && npm install
npm run tauri dev                     # native window (host only, needs a display)
```

Dev hosts (Traefik on the external `proxy` network): add `backurau.local` to `/etc/hosts`; the service token is in `docker compose logs server`.

VS Code: F6 = default build task "Dev" (agent CLIs + `.vscode/tasks.sh` + Desktop), F7 = default test task "Desktop".

## Commands

| Command                                                   | What it does                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| `cargo test --manifest-path core/Cargo.toml`              | Engine tests (temporary fixtures only)                            |
| `cd tauri-app && npm test`                                | UI unit tests (vitest + jsdom)                                    |
| `cd tauri-app && npm run build`                           | Type-check and build the UI into `tauri-app/ui`                   |
| `cargo build --manifest-path server/Cargo.toml && node scripts/verify-integration.mjs` | HTTP end-to-end check, prints "integration passed" |
| `docker compose logs -f server`                           | Follow the web service                                            |
| `docker compose --profile build run --rm bundle`          | Build the `.deb` into `./dist`                                    |
| `cd tauri-app && npm run tauri dev` / `tauri build`       | Native app / bundles                                              |
| `cd tauri-app && ./check-deps.sh`                         | List missing GTK/WebKit system libraries                          |

## Architecture

- Engine contract: `Engine::new(data_dir)`, `dispatch(method, json)`, `tick()` (adapters call it every 5 s), `default_data_dir()` (honors `BACKURAU_DATA_DIR`).
- Runs revalidate the comparison before changing files; replaced and deleted files are kept as retained versions (not a point-in-time image). Two-way mode keeps per-plan baselines.
- Credentials go to the OS keyring only, never to JSON, logs, exports or returned state.
- Service env: `PORT`, `BIND`, `BACKURAU_DATA_DIR`, `BACKURAU_TOKEN`, `BACKURAU_ALLOWED_ORIGINS`, `BACKURAU_ALLOW_REMOTE=1` (required to listen beyond loopback).
- Not verifiable on this Linux host: Windows/macOS builds and live cloud-provider auth. rclone is needed for cloud/SFTP/WebDAV; rsync for the optional local engine.

## Docker

- `.docker/server/Dockerfile` - `development` stage: Rust toolchain, rsync, rclone; `server/`, `core/` and the built UI are bind-mounted, `CARGO_HOME` / `CARGO_TARGET_DIR` live in named volumes so the container runs as the host user.
- `.docker/bundle/Dockerfile` - `bundle` stage: WebKit/GTK dev libs + Node, builds the `.deb` (AppImage needs FUSE, unavailable in containers).
- `compose.yml` - `server` (always on) and `bundle` (`build` profile). Needs the external `proxy` network.
