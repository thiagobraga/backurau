# Providers: what works where

Backurau moves files through three providers. Each is chosen per folder, not per app.

| Provider | Used for | Needs |
| --- | --- | --- |
| Native (Rust) | Local folders, including SMB/NFS shares mounted on this computer | nothing |
| rclone | SFTP, S3-compatible, WebDAV, SMB by host, configured rclone remotes (Google Drive, OneDrive) | `rclone` on `PATH` (or `BACKURAU_RCLONE`) |
| rsync | Optional copy engine for local folders (plan engine `rsync`) | `rsync` on `PATH` |

The engine reports what is available in `get_state().capabilities`. The UI only offers what is reported there.

## Folders and connections

- A folder is either an absolute local path or `connection://<id>/<relative>`.
- Mounted SMB and NFS shares are local folders. Backurau does not speak SMB or NFS itself; it sees the mount point.
- Connections store only metadata (name, address, user, port, remote, options). Passwords and keys go to the OS credential store (Keychain, Credential Manager, or Secret Service). They never appear in plan or settings JSON, logs, exports, or API responses.

## Connection kinds

| Kind | How it is reached | Credentials | Status |
| --- | --- | --- | --- |
| `local` | Native | none | Tested on Linux with temporary folders |
| `smb` | rclone SMB backend by host (`host/share/path`) | password in OS store | Needs rclone; not tested against a live server |
| `sftp` | rclone SFTP backend | password in OS store (keys are not managed by Backurau) | Needs rclone; not tested against a live server |
| `s3` | rclone S3 backend, `provider=Other` with the given endpoint | access key ID as user, secret in OS store | Needs rclone; not tested against a live server |
| `webdav` | rclone WebDAV backend | password in OS store | Needs rclone; not tested against a live server |
| `gdrive`, `onedrive` | Not reachable without a configured rclone remote | OAuth token lives in the rclone remote | Create the remote with `rclone config`, then set the remote name on the connection |
| `rclone` | Any configured rclone remote | in the rclone config | Set the remote name on the connection |

Backurau never runs OAuth flows itself. For Google Drive and OneDrive, sign-in happens in `rclone config`.

## How rclone is called

- Secrets are passed through environment variables (`RCLONE_*_PASS`, `RCLONE_S3_SECRET_ACCESS_KEY`), obscured where rclone requires it. They are never on the command line.
- Each call has a timeout. Errors come back as the last non-empty line of rclone's stderr.
- Remote paths are built from quoted parameters. Relative paths are checked for traversal before use.
- Listings with rclone do not compare contents. Comparison uses size and modified time, so `content` compare is not available for rclone folders (`content_compare: false`).
- rclone cannot replace files atomically. Copies to rclone folders go through a local staging file and `copyto`.

## Native copy guarantees

- Local copies write to a temporary file in the destination folder and rename it into place (`atomic_replace: true`).
- Modified time is preserved (`preserves_mtime: true`).
- Symlinks are rejected below the root. Nested or overlapping source and destination roots are rejected.
- Content compare uses SHA-256 when a plan asks for it.

## Platform boundaries

| Platform | What this repository verifies | What it does not verify |
| --- | --- | --- |
| Linux (this host) | Core tests, UI tests and build, server build, HTTP integration script (temporary folders, token and origin checks, destructive run refused without confirmation, run and restore) | Live cloud or SFTP servers |
| Windows | CI build job defined in `.github/workflows/ci.yml` | Nothing has been run on Windows from this repository. Results come from CI only once it has run. |
| macOS | CI build job defined in `.github/workflows/ci.yml` | Nothing has been run on macOS from this repository. Results come from CI only once it has run. |

Other limits:

- rsync and rclone are external tools. When they are missing, the related options are disabled, and the UI says so.
- Live provider sign-in needs user accounts. None were exercised here, so connection status for real providers is not verified.
- The `.deb` bundle is built in Docker (`docker compose --profile build run --rm bundle`). AppImage needs FUSE, which containers do not provide.

## Testing providers

- `core/src/providers.rs` has unit tests for rclone spec building and RFC 3339 parsing. The tests check that no secret reaches the command line.
- Provider fixtures are temporary directories only. Real user folders are never used as test input.
