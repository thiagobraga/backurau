//! Location access. Local folders (including mounted SMB/NFS shares) are handled natively;
//! SFTP, S3, WebDAV, SMB-by-host and configured rclone remotes go through the `rclone` binary.
//! Roots are absolute local paths or `connection://<id>/<relative path>`.
use crate::credentials;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileMeta {
    pub size: u64,
    pub modified: u64,
    pub is_dir: bool,
    pub hash: Option<String>,
}

pub type Tree = BTreeMap<String, FileMeta>;

#[derive(Debug, Default)]
pub struct Listing {
    pub tree: Tree,
    pub warnings: Vec<String>,
}

pub const KINDS: [&str; 8] = ["local", "smb", "sftp", "s3", "webdav", "gdrive", "onedrive", "rclone"];

#[derive(Clone, Debug, PartialEq)]
enum Location {
    Local(PathBuf),
    Rclone { spec: String, env: Vec<(String, String)> },
}

pub struct Provider {
    connections: Vec<Value>,
    // Credentials are read and obscured once per connection, not once per file.
    targets: std::sync::Mutex<BTreeMap<String, (String, Vec<(String, String)>)>>,
}

fn s(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

pub fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\\')
        && !value.contains('\0')
        && Path::new(value).components().all(|c| matches!(c, Component::Normal(_)))
}

fn join_rel(base: &str, name: &str) -> String {
    if base.is_empty() { name.to_string() } else { format!("{base}/{name}") }
}

fn mtime(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Refuses to touch anything below `root` through a symbolic link.
fn reject_symlinks_below(root: &Path, rel: &str) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for part in rel.split('/') {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!("Refusing to follow symbolic link: {}", current.display()))
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("Cannot inspect {}: {e}", current.display())),
        }
    }
    Ok(())
}

impl Provider {
    pub fn new(connections: Value) -> Self {
        Self { connections: connections.as_array().cloned().unwrap_or_default(), targets: Default::default() }
    }

    fn resolve(&self, root: &str) -> Result<Location, String> {
        let Some(rest) = root.strip_prefix("connection://") else {
            let path = Path::new(root);
            if !path.is_absolute() {
                return Err(format!("Folder paths must be absolute: {root}"));
            }
            return Ok(Location::Local(path.to_path_buf()));
        };
        let (id, rel) = rest.split_once('/').unwrap_or((rest, ""));
        let rel = rel.trim_end_matches('/');
        if !rel.is_empty() && !safe_relative(rel) {
            return Err(format!("Unsafe path in {root}"));
        }
        let connection = self
            .connections
            .iter()
            .find(|c| s(c, "id") == id)
            .ok_or_else(|| format!("Connection not found for {root}"))?;
        let address = s(connection, "address");
        if s(connection, "kind") == "local" || (s(connection, "remote").is_empty() && Path::new(&address).is_absolute()) {
            let base = PathBuf::from(&address);
            return Ok(Location::Local(if rel.is_empty() { base } else { base.join(rel) }));
        }
        let mut targets = self.targets.lock().map_err(|_| "Provider lock poisoned")?;
        let (base, env) = match targets.get(id) {
            Some(target) => target.clone(),
            None => {
                let target = rclone_target(connection)?;
                targets.insert(id.to_string(), target.clone());
                target
            }
        };
        Ok(Location::Rclone { spec: join_spec(&base, rel), env })
    }

    /// Fails for unavailable roots: an unreachable destination must never look empty.
    pub fn check_root(&self, root: &str) -> Result<(), String> {
        match self.resolve(root)? {
            Location::Local(path) => {
                let meta = fs::symlink_metadata(&path).map_err(|e| format!("{} is unavailable: {e}", path.display()))?;
                if meta.file_type().is_symlink() {
                    let target = fs::metadata(&path).map_err(|e| format!("{} is unavailable: {e}", path.display()))?;
                    if !target.is_dir() {
                        return Err(format!("{} is not a folder", path.display()));
                    }
                } else if !meta.is_dir() {
                    return Err(format!("{} is not a folder", path.display()));
                }
                fs::read_dir(&path).map(|_| ()).map_err(|e| format!("{} is not readable: {e}", path.display()))
            }
            Location::Rclone { spec, env } => rclone(&env, &["lsjson", "--max-depth", "1", &spec], None)
                .map(|_| ())
                .map_err(|e| format!("{root} is unavailable: {e}")),
        }
    }

    /// Rejects two local roots where one contains the other.
    pub fn check_pair(&self, a: &str, b: &str) -> Result<(), String> {
        if let (Location::Local(a), Location::Local(b)) = (self.resolve(a)?, self.resolve(b)?) {
            let a = fs::canonicalize(&a).map_err(|e| format!("{}: {e}", a.display()))?;
            let b = fs::canonicalize(&b).map_err(|e| format!("{}: {e}", b.display()))?;
            if a.starts_with(&b) || b.starts_with(&a) {
                return Err(format!("Folders overlap: {} and {}", a.display(), b.display()));
            }
        }
        Ok(())
    }

    pub fn local_path(&self, root: &str) -> Option<PathBuf> {
        match self.resolve(root).ok()? {
            Location::Local(path) => Some(path),
            Location::Rclone { .. } => None,
        }
    }

    /// Recursive listing with `/`-separated relative paths. `prune(path, is_dir)` returning true keeps
    /// the entry but does not descend into it or hash it (used for excluded folders).
    pub fn list(&self, root: &str, hash: bool, prune: &dyn Fn(&str, bool) -> bool) -> Result<Listing, String> {
        let mut listing = Listing::default();
        match self.resolve(root)? {
            Location::Local(base) => {
                self.check_root(root)?;
                walk_local(&base, "", hash, prune, &mut listing)?;
            }
            Location::Rclone { spec, env } => {
                if hash {
                    return Err("Content comparison is only available for local folders; use Time & size for connections".into());
                }
                let out = rclone(&env, &["lsjson", "-R", "--no-mimetype", &spec], None)?;
                let items: Vec<Value> = serde_json::from_slice(&out).map_err(|e| format!("Unexpected rclone listing: {e}"))?;
                for item in items {
                    let path = s(&item, "Path");
                    if !safe_relative(&path) {
                        return Err(format!("rclone returned an unsafe path: {path}"));
                    }
                    let meta = FileMeta {
                        size: item.get("Size").and_then(Value::as_i64).unwrap_or(0).max(0) as u64,
                        modified: parse_rfc3339(&s(&item, "ModTime")).unwrap_or(0),
                        is_dir: item.get("IsDir").and_then(Value::as_bool).unwrap_or(false),
                        hash: None,
                    };
                    listing.tree.insert(path, meta);
                }
                // Drop descendants of pruned folders so remote and local listings agree.
                let pruned: Vec<String> = listing.tree.iter().filter(|(p, m)| m.is_dir && prune(p, true)).map(|(p, _)| format!("{p}/")).collect();
                listing.tree.retain(|p, _| !pruned.iter().any(|d| p.starts_with(d)));
            }
        }
        Ok(listing)
    }

    pub fn mkdir(&self, root: &str, rel: &str) -> Result<(), String> {
        match self.resolve(root)? {
            Location::Local(base) => {
                reject_symlinks_below(&base, rel)?;
                fs::create_dir_all(base.join(rel)).map_err(|e| format!("Cannot create {rel}: {e}"))
            }
            Location::Rclone { spec, env } => rclone(&env, &["mkdir", &join_spec(&spec, rel)], None).map(|_| ()),
        }
    }

    /// Copies one file through a temporary name and renames it into place, keeping the modification
    /// time and verifying the size. `overwrite == false` refuses to replace an existing file.
    pub fn copy(&self, from_root: &str, from_rel: &str, to_root: &str, to_rel: &str, overwrite: bool) -> Result<u64, String> {
        match (self.resolve(from_root)?, self.resolve(to_root)?) {
            (Location::Local(from), Location::Local(to)) => {
                reject_symlinks_below(&from, from_rel)?;
                reject_symlinks_below(&to, to_rel)?;
                copy_local(&from.join(from_rel), &to.join(to_rel), overwrite)
            }
            (Location::Rclone { spec: a, env: ea }, Location::Rclone { spec: b, env: eb }) => {
                // Different connections can need conflicting credentials, so stage through a local file.
                let stage = std::env::temp_dir().join(format!("backurau-stage-{}", uuid::Uuid::new_v4()));
                let result = rclone(&ea, &["copyto", &join_spec(&a, from_rel), &stage.to_string_lossy()], None)
                    .and_then(|_| rclone(&eb, &["copyto", &stage.to_string_lossy(), &join_spec(&b, to_rel)], None))
                    .and_then(|_| fs::metadata(&stage).map(|m| m.len()).map_err(|e| e.to_string()));
                let _ = fs::remove_file(&stage);
                result
            }
            (Location::Local(from), Location::Rclone { spec, env }) => {
                reject_symlinks_below(&from, from_rel)?;
                let src = from.join(from_rel);
                let size = fs::metadata(&src).map_err(|e| format!("{}: {e}", src.display()))?.len();
                rclone(&env, &["copyto", &src.to_string_lossy(), &join_spec(&spec, to_rel)], None)?;
                Ok(size)
            }
            (Location::Rclone { spec, env }, Location::Local(to)) => {
                reject_symlinks_below(&to, to_rel)?;
                let dst = to.join(to_rel);
                if !overwrite && fs::symlink_metadata(&dst).is_ok() {
                    return Err(format!("{} already exists", dst.display()));
                }
                if let Some(parent) = dst.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                rclone(&env, &["copyto", &join_spec(&spec, from_rel), &dst.to_string_lossy()], None)?;
                fs::metadata(&dst).map(|m| m.len()).map_err(|e| e.to_string())
            }
        }
    }

    /// rsync engine for local-to-local copies; falls back to `copy` elsewhere.
    pub fn copy_rsync(&self, from_root: &str, from_rel: &str, to_root: &str, to_rel: &str, overwrite: bool) -> Result<u64, String> {
        let (Location::Local(from), Location::Local(to)) = (self.resolve(from_root)?, self.resolve(to_root)?) else {
            return self.copy(from_root, from_rel, to_root, to_rel, overwrite);
        };
        reject_symlinks_below(&from, from_rel)?;
        reject_symlinks_below(&to, to_rel)?;
        let (src, dst) = (from.join(from_rel), to.join(to_rel));
        if !overwrite && fs::symlink_metadata(&dst).is_ok() {
            return Err(format!("{} already exists", dst.display()));
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // --delay-updates writes to a temporary name and renames at the end, like the native engine.
        let out = Command::new("rsync")
            .args(["--times", "--perms", "--no-links", "--delay-updates", "--"])
            .arg(&src)
            .arg(&dst)
            .output()
            .map_err(|e| format!("rsync is not available: {e}"))?;
        if !out.status.success() {
            return Err(format!("rsync failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        let (a, b) = (fs::metadata(&src).map_err(|e| e.to_string())?, fs::metadata(&dst).map_err(|e| e.to_string())?);
        if a.len() != b.len() {
            return Err(format!("Size mismatch after copying {from_rel}"));
        }
        Ok(b.len())
    }

    /// Removes one file or one empty folder; never recursive.
    pub fn remove(&self, root: &str, rel: &str, is_dir: bool) -> Result<(), String> {
        match self.resolve(root)? {
            Location::Local(base) => {
                reject_symlinks_below(&base, rel)?;
                let path = base.join(rel);
                if is_dir { fs::remove_dir(&path) } else { fs::remove_file(&path) }.map_err(|e| format!("Cannot remove {rel}: {e}"))
            }
            Location::Rclone { spec, env } => {
                rclone(&env, &[if is_dir { "rmdir" } else { "deletefile" }, &join_spec(&spec, rel)], None).map(|_| ())
            }
        }
    }

    /// Checks reachability and authentication. Returns the connection with updated status fields.
    pub fn test_connection(&self, connection: &Value) -> Result<Value, String> {
        let mut updated = connection.clone();
        let root = format!("connection://{}", s(connection, "id"));
        let needs_rclone = matches!(self.resolve(&root), Ok(Location::Rclone { .. }) | Err(_)) && s(connection, "kind") != "local";
        let (status, message) = if needs_rclone && !rclone_available() {
            ("unavailable", format!("rclone is not installed. Install rclone to use {} connections.", s(connection, "kind")))
        } else {
            match self.check_root(&root) {
                Ok(()) => ("available", "Reachable and readable.".to_string()),
                Err(e) => {
                    let lower = e.to_lowercase();
                    let auth = ["auth", "401", "403", "password", "permission denied", "credentials", "token", "unable to authenticate"];
                    if auth.iter().any(|w| lower.contains(w)) { ("needs_authentication", e) } else { ("unavailable", e) }
                }
            }
        };
        updated["status"] = json!(status);
        updated["message"] = json!(message.chars().take(400).collect::<String>());
        updated["last_checked"] = json!(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()));
        Ok(updated)
    }
}

fn walk_local(base: &Path, rel: &str, hash: bool, prune: &dyn Fn(&str, bool) -> bool, out: &mut Listing) -> Result<(), String> {
    let dir = if rel.is_empty() { base.to_path_buf() } else { base.join(rel) };
    let entries = fs::read_dir(&dir).map_err(|e| format!("Cannot read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Cannot read {}: {e}", dir.display()))?;
        let name = entry.file_name().into_string().map_err(|n| format!("Unsupported file name in {}: {:?}", dir.display(), n))?;
        let path = join_rel(rel, &name);
        let kind = entry.file_type().map_err(|e| format!("Cannot inspect {path}: {e}"))?;
        if kind.is_symlink() {
            out.warnings.push(format!("Skipped symbolic link: {path}"));
            continue;
        }
        let meta = entry.metadata().map_err(|e| format!("Cannot inspect {path}: {e}"))?;
        if meta.is_dir() {
            out.tree.insert(path.clone(), FileMeta { size: 0, modified: mtime(&meta), is_dir: true, hash: None });
            if !prune(&path, true) {
                walk_local(base, &path, hash, prune, out)?;
            }
        } else if meta.is_file() {
            let pruned = prune(&path, false);
            let digest = if hash && !pruned { Some(sha256_file(&entry.path())?) } else { None };
            out.tree.insert(path, FileMeta { size: meta.len(), modified: mtime(&meta), is_dir: false, hash: digest });
        } else {
            out.warnings.push(format!("Skipped special file: {path}"));
        }
    }
    Ok(())
}

fn copy_local(src: &Path, dst: &Path, overwrite: bool) -> Result<u64, String> {
    let meta = fs::symlink_metadata(src).map_err(|e| format!("{}: {e}", src.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a regular file", src.display()));
    }
    match fs::symlink_metadata(dst) {
        Ok(existing) if existing.is_dir() => return Err(format!("{} is a folder", dst.display())),
        Ok(_) if !overwrite => return Err(format!("{} already exists", dst.display())),
        _ => {}
    }
    let parent = dst.parent().ok_or("Destination has no parent folder")?;
    fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    let temp = parent.join(format!(".backurau-{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let copied = fs::copy(src, &temp).map_err(|e| format!("Cannot copy {}: {e}", src.display()))?;
        let file = fs::OpenOptions::new().write(true).open(&temp).map_err(|e| e.to_string())?;
        if let Ok(modified) = meta.modified() {
            file.set_modified(modified).map_err(|e| format!("Cannot set modification time: {e}"))?;
        }
        file.sync_all().map_err(|e| e.to_string())?;
        if copied != meta.len() || fs::metadata(&temp).map_err(|e| e.to_string())?.len() != meta.len() {
            return Err(format!("Size mismatch while copying {}", src.display()));
        }
        fs::rename(&temp, dst).map_err(|e| format!("Cannot replace {}: {e}", dst.display()))?;
        Ok(copied)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

// ---------- rclone ----------

fn rclone_bin() -> String {
    std::env::var("BACKURAU_RCLONE").unwrap_or_else(|_| "rclone".into())
}

pub fn rclone_available() -> bool {
    Command::new(rclone_bin()).arg("version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

pub fn rsync_available() -> bool {
    Command::new("rsync").arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

/// Runs rclone with credentials passed through the environment, never on the command line.
fn rclone(env: &[(String, String)], args: &[&str], stdin: Option<&str>) -> Result<Vec<u8>, String> {
    let mut child = Command::new(rclone_bin())
        .args(args)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("rclone is not available: {e}"))?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(input.as_bytes()).map_err(|e| e.to_string())?;
    }
    // Network calls can hang; listing big remotes can legitimately take a while.
    let deadline = Instant::now() + Duration::from_secs(if args.first() == Some(&"lsjson") { 600 } else { 3600 });
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("rclone timed out".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("rclone failed");
        Err(line.trim().chars().take(300).collect())
    }
}

fn obscure(secret: &str) -> Result<String, String> {
    let out = rclone(&[], &["obscure", "-"], Some(secret))?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

fn quote(value: &str) -> Result<String, String> {
    if value.contains('"') || value.contains('\n') {
        return Err("Connection fields cannot contain quotes or line breaks".into());
    }
    Ok(format!("\"{value}\""))
}

fn join_spec(base: &str, rel: &str) -> String {
    if rel.is_empty() {
        base.to_string()
    } else if base.ends_with(':') || base.ends_with('/') {
        format!("{base}{rel}")
    } else {
        format!("{base}/{rel}")
    }
}

/// Builds an rclone target for a connection: a configured remote, or an on-the-fly backend string.
fn rclone_target(c: &Value) -> Result<(String, Vec<(String, String)>), String> {
    let (kind, address, user, remote) = (s(c, "kind"), s(c, "address"), s(c, "user"), s(c, "remote"));
    let path = c.get("options").map(|o| s(o, "path")).unwrap_or_default();
    let path = path.trim_start_matches('/').to_string();
    let secret = || credentials::get(&s(c, "id"));
    let mut env = vec![];
    let base = if !remote.is_empty() {
        let name = remote.trim_end_matches(':');
        if name.is_empty() || name.contains(['"', '\n', ' ']) {
            return Err("Invalid rclone remote name".into());
        }
        format!("{name}:")
    } else {
        match kind.as_str() {
            "sftp" => {
                let mut spec = format!(":sftp,host={}", quote(&address)?);
                if !user.is_empty() { spec += &format!(",user={}", quote(&user)?); }
                if let Some(port) = c.get("port").and_then(Value::as_u64) { spec += &format!(",port={port}"); }
                if let Some(pass) = secret()? { env.push(("RCLONE_SFTP_PASS".into(), obscure(&pass)?)); }
                spec + ":"
            }
            "webdav" => {
                let mut spec = format!(":webdav,url={}", quote(&address)?);
                if !user.is_empty() { spec += &format!(",user={}", quote(&user)?); }
                if let Some(pass) = secret()? { env.push(("RCLONE_WEBDAV_PASS".into(), obscure(&pass)?)); }
                spec + ":"
            }
            "s3" => {
                env.push(("RCLONE_S3_ENV_AUTH".into(), "false".into()));
                if !user.is_empty() { env.push(("RCLONE_S3_ACCESS_KEY_ID".into(), user.clone())); }
                if let Some(key) = secret()? { env.push(("RCLONE_S3_SECRET_ACCESS_KEY".into(), key)); }
                format!(":s3,provider=Other,endpoint={}:", quote(&address)?)
            }
            "smb" => {
                let mut spec = format!(":smb,host={}", quote(address.split('/').next().unwrap_or_default())?);
                if !user.is_empty() { spec += &format!(",user={}", quote(&user)?); }
                if let Some(pass) = secret()? { env.push(("RCLONE_SMB_PASS".into(), obscure(&pass)?)); }
                // "host/share/dir" addresses carry the share in the path.
                let share = address.split_once('/').map(|(_, p)| p.to_string()).unwrap_or_default();
                return Ok((join_spec(&(spec + ":"), &join_rel(&share, &path).trim_matches('/').to_string()), env));
            }
            "gdrive" | "onedrive" | "rclone" => {
                return Err(format!("Set the rclone remote name for this {kind} connection (create it with `rclone config`)"))
            }
            other => return Err(format!("Unsupported connection type: {other}")),
        }
    };
    Ok((join_spec(&base, &path), env))
}

/// `2024-11-02T10:15:03.123+01:00` -> Unix seconds.
fn parse_rfc3339(value: &str) -> Option<u64> {
    let n = |a: usize, b: usize| value.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, sec) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    let tail = &value[19..];
    let tz = tail.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let offset = if tz.is_empty() || tz == "Z" {
        0
    } else {
        let sign = if tz.starts_with('-') { -1 } else { 1 };
        sign * (tz.get(1..3)?.parse::<i64>().ok()? * 3600 + tz.get(4..6)?.parse::<i64>().ok()? * 60)
    };
    // Days from civil date (Howard Hinnant).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(days * 86400 + h * 3600 + mi * 60 + sec - offset).ok()
}

pub fn capabilities() -> Value {
    let rclone = rclone_available();
    json!({
        "kinds": KINDS,
        "local": {"available": true, "content_compare": true, "atomic_replace": true, "preserves_mtime": true},
        "mounted_shares": "SMB/NFS shares mounted on this computer are used as local folders",
        "rclone": {"available": rclone, "kinds": ["sftp", "s3", "webdav", "smb", "gdrive", "onedrive", "rclone"],
                   "content_compare": false, "atomic_replace": false,
                   "oauth": "Google Drive and OneDrive need a remote created with `rclone config`"},
        "rsync": {"available": rsync_available(), "scope": "local folders only"},
        "credentials": credentials::status(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc3339() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2024-11-02T10:15:00.5+01:00"), Some(1730538900));
    }

    #[test]
    fn builds_rclone_specs_without_secrets_on_the_command_line() {
        let c = json!({"id": "x", "kind": "s3", "address": "https://s3.example.com", "user": "AK", "options": {"path": "bucket/dir"}});
        let p = Provider::new(json!([c]));
        match p.resolve("connection://x/sub").unwrap() {
            Location::Rclone { spec, env } => {
                assert_eq!(spec, ":s3,provider=Other,endpoint=\"https://s3.example.com\":bucket/dir/sub");
                assert!(env.iter().any(|(k, v)| k == "RCLONE_S3_ACCESS_KEY_ID" && v == "AK"));
            }
            other => panic!("{other:?}"),
        }
        let remote = Provider::new(json!([{"id": "g", "kind": "gdrive", "remote": "drive", "address": ""}]));
        assert!(matches!(remote.resolve("connection://g/a").unwrap(), Location::Rclone { spec, .. } if spec == "drive:a"));
        assert!(Provider::new(json!([])).resolve("relative/path").is_err());
        assert!(Provider::new(json!([c_local()])).resolve("connection://l/../x").is_err());
    }

    fn c_local() -> Value {
        json!({"id": "l", "kind": "local", "address": "/mnt/share"})
    }
}
