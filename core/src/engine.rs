use crate::{
    credentials,
    models::*,
    providers::{self, safe_relative, FileMeta, Provider, Tree},
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const MAX_RUNS: usize = 500;
const MAX_ACTIONS_PER_RUN: usize = 5000;
const CHANGE_POLL_SECONDS: u64 = 15;

/// Shared engine used by the desktop app and the web service. Cheap to clone; all clones share state.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

struct Inner {
    dir: PathBuf,
    state: Mutex<State>,
    run_lock: Mutex<()>,
    cancel: AtomicBool,
    capabilities: OnceLock<Value>,
    // Held for the engine's lifetime so a desktop app and a service never share one data folder.
    _process_lock: File,
}

struct State {
    saved: SavedState,
    previews: BTreeMap<String, Preview>,
    active: Option<Job>,
    logs: Vec<Log>,
    triggers: BTreeMap<String, Trigger>,
    queued: Vec<String>,
}

#[derive(Clone)]
struct Preview {
    comparison: Comparison,
    plan: Plan,
}

#[derive(Default)]
struct Trigger {
    available: Option<bool>,
    fingerprint: Option<String>,
    changed: bool,
    last_poll: u64,
    last_attempt: u64,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn new_id() -> String {
    Uuid::new_v4().simple().to_string()
}

fn field<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| format!("Missing field: {key}"))
}

fn to_json<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

impl Engine {
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&data_dir).map_err(|e| format!("Cannot create {}: {e}", data_dir.display()))?;
        let dir = fs::canonicalize(&data_dir).map_err(|e| e.to_string())?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join("engine.lock"))
            .map_err(|e| e.to_string())?;
        lock.try_lock().map_err(|_| {
            "Backurau data is in use by another Backurau window or service. Close it, or open that service's web interface.".to_string()
        })?;
        let path = dir.join("state-v1.json");
        let mut saved: SavedState = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("Cannot read {}; the file was left untouched: {e}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => SavedState::default(),
            Err(e) => return Err(format!("Cannot read {}: {e}", path.display())),
        };
        if saved.schema != 1 {
            return Err(format!("{} uses an unsupported schema; the file was left untouched", path.display()));
        }
        saved.settings = merge(default_settings(), saved.settings);
        // A run still marked running means the process stopped mid-run.
        for run in &mut saved.runs {
            if run.status == "running" {
                run.status = "interrupted".into();
                run.finished = Some(now());
                run.warnings.push("Backurau stopped during this run. Finished actions were not rolled back; compare again before retrying.".into());
            }
            if run.snapshot_state == "available" && run.versions.iter().any(|v| !dir.join("versions").join(&run.id).join(&v.id).is_file()) {
                run.snapshot_state = "unavailable".into();
            }
        }
        let engine = Self {
            inner: Arc::new(Inner {
                dir,
                state: Mutex::new(State {
                    saved,
                    previews: BTreeMap::new(),
                    active: None,
                    logs: vec![],
                    triggers: BTreeMap::new(),
                    queued: vec![],
                }),
                run_lock: Mutex::new(()),
                cancel: AtomicBool::new(false),
                capabilities: OnceLock::new(),
                _process_lock: lock,
            }),
        };
        engine.persist(&engine.state()?.saved)?;
        Ok(engine)
    }

    pub fn data_dir(&self) -> &Path {
        &self.inner.dir
    }

    fn state(&self) -> Result<MutexGuard<'_, State>, String> {
        self.inner.state.lock().map_err(|_| "Engine state lock poisoned; restart Backurau".to_string())
    }

    fn persist(&self, saved: &SavedState) -> Result<(), String> {
        let target = self.inner.dir.join("state-v1.json");
        let temp = self.inner.dir.join(format!(".state-{}.tmp", new_id()));
        let write = || -> std::io::Result<()> {
            let mut file = File::create(&temp)?;
            file.write_all(&serde_json::to_vec_pretty(saved)?)?;
            file.sync_all()?;
            fs::rename(&temp, &target)?;
            #[cfg(unix)]
            File::open(&self.inner.dir)?.sync_all()?;
            Ok(())
        };
        write().map_err(|e| {
            let _ = fs::remove_file(&temp);
            format!("Cannot save state: {e}")
        })
    }

    /// Applies `f` to a copy of the saved state and commits it only if saving succeeds.
    fn mutate<T>(&self, f: impl FnOnce(&mut SavedState) -> Result<T, String>) -> Result<T, String> {
        let mut state = self.state()?;
        let mut next = state.saved.clone();
        let result = f(&mut next)?;
        self.persist(&next)?;
        state.saved = next;
        Ok(result)
    }

    fn log(&self, level: &str, message: impl Into<String>) {
        if let Ok(mut state) = self.state() {
            state.logs.push(Log { ts: now(), level: level.into(), message: message.into() });
            if state.logs.len() > 1000 {
                state.logs.drain(..200);
            }
        }
    }

    pub fn dispatch(&self, method: &str, args: Value) -> Result<Value, String> {
        match method {
            "get_state" => {
                let state = self.state()?;
                let runs: Vec<Run> = state.saved.runs.iter().map(summary).collect();
                Ok(json!({
                    "plans": state.saved.plans, "last_plan_id": state.saved.last_plan_id,
                    "settings": state.saved.settings, "connections": state.saved.connections,
                    "runs": runs, "capabilities": self.capabilities(),
                }))
            }
            "save_plan" => self.save_plan(args.get("plan").cloned().ok_or("Missing plan")?, false),
            "import_plan" => self.save_plan(args.get("plan").cloned().ok_or("Missing plan")?, true),
            "delete_plan" => {
                let id = field(&args, "id")?;
                self.mutate(|s| {
                    if !s.plans.iter().any(|p| p.id == id) {
                        return Err("Plan not found".into());
                    }
                    s.plans.retain(|p| p.id != id);
                    s.baselines.remove(id);
                    if s.last_plan_id.as_deref() == Some(id) {
                        s.last_plan_id = s.plans.first().map(|p| p.id.clone());
                    }
                    Ok(())
                })?;
                Ok(Value::Null)
            }
            "select_plan" => {
                let id = field(&args, "id")?;
                self.mutate(|s| {
                    if !s.plans.iter().any(|p| p.id == id) {
                        return Err("Plan not found".into());
                    }
                    s.last_plan_id = Some(id.into());
                    Ok(())
                })?;
                Ok(Value::Null)
            }
            "export_plan" => {
                let id = field(&args, "id")?;
                let state = self.state()?;
                to_json(state.saved.plans.iter().find(|p| p.id == id).ok_or("Plan not found")?)
            }
            "compare_plan" => to_json(self.compare(field(&args, "plan_id")?)?),
            "run_plan" => {
                let selected: Vec<String> = serde_json::from_value(args.get("selected").cloned().unwrap_or(json!([]))).map_err(|e| e.to_string())?;
                let resolutions: BTreeMap<String, String> =
                    serde_json::from_value(args.get("resolutions").cloned().unwrap_or(json!({}))).map_err(|e| e.to_string())?;
                let confirm = args.get("confirm_destructive").and_then(Value::as_bool).unwrap_or(false);
                to_json(self.run(field(&args, "comparison_id")?, &selected, &resolutions, confirm, "manual")?)
            }
            "get_activity" => {
                let state = self.state()?;
                Ok(json!({"active": state.active, "queued": state.queued, "logs": state.logs}))
            }
            "cancel_run" => {
                self.inner.cancel.store(true, Ordering::SeqCst);
                Ok(Value::Null)
            }
            "list_runs" => to_json(self.state()?.saved.runs.iter().map(summary).collect::<Vec<_>>()),
            "get_run" => {
                let id = field(&args, "id")?;
                let state = self.state()?;
                to_json(state.saved.runs.iter().find(|r| r.id == id).ok_or("Run not found")?)
            }
            "restore_versions" => self.restore(&args),
            "prune_snapshot" => {
                let _guard = self.inner.run_lock.try_lock().map_err(|_| "Wait for the active run to finish")?;
                let id = field(&args, "id")?.to_string();
                self.mutate(|s| prune(&self.inner.dir, s, &id))?;
                Ok(Value::Null)
            }
            "save_settings" => {
                let settings = merge(default_settings(), args.get("settings").cloned().ok_or("Missing settings")?);
                validate_settings(&settings)?;
                self.mutate(|s| {
                    s.settings = settings.clone();
                    Ok(())
                })?;
                Ok(settings)
            }
            "save_connection" => self.save_connection(&args),
            "delete_connection" => {
                let id = field(&args, "id")?.to_string();
                let prefix = format!("connection://{id}");
                self.mutate(|s| {
                    if let Some(plan) = s.plans.iter().find(|p| p.pairs.iter().any(|x| x.left.starts_with(&prefix) || x.right.starts_with(&prefix))) {
                        return Err(format!("Connection is used by plan \"{}\"", plan.name));
                    }
                    let before = s.connections.len();
                    s.connections.retain(|c| c.get("id").and_then(Value::as_str) != Some(&id));
                    if s.connections.len() == before {
                        return Err("Connection not found".into());
                    }
                    Ok(())
                })?;
                credentials::delete(&id).unwrap_or_else(|e| self.log("warning", e));
                Ok(Value::Null)
            }
            "test_connection" => {
                let id = field(&args, "id")?;
                let (connection, all) = {
                    let state = self.state()?;
                    let c = state.saved.connections.iter().find(|c| c.get("id").and_then(Value::as_str) == Some(id)).cloned();
                    (c.ok_or("Connection not found")?, state.saved.connections.clone())
                };
                let updated = Provider::new(json!(all)).test_connection(&connection)?;
                self.mutate(|s| {
                    if let Some(c) = s.connections.iter_mut().find(|c| c.get("id").and_then(Value::as_str) == Some(id)) {
                        *c = updated.clone();
                    }
                    Ok(())
                })?;
                Ok(updated)
            }
            _ => Err(format!("Unknown method: {method}")),
        }
    }

    fn capabilities(&self) -> Value {
        self.inner
            .capabilities
            .get_or_init(|| {
                json!({
                    "providers": providers::capabilities(),
                    "modes": ["mirror", "update", "two_way", "custom"],
                    "methods": ["time_size", "content"],
                    "filters": {"glob": true, "regex_prefix": "regex:", "case_sensitive": true, "exclude_wins": true,
                                "matching": "patterns without / match names at any depth; patterns with / match the full relative path"},
                    "snapshots": "retained_file_versions",
                    "automation": {"interval": true, "on_change": true, "on_available": true, "requires_running_process": true, "change_poll_seconds": CHANGE_POLL_SECONDS},
                    "notifications": {"in_app": true, "desktop": false},
                    "cancellation": "between_file_operations",
                    "symlinks": "skipped_with_warning",
                    "encrypted_vault": false,
                    "data_dir": self.inner.dir,
                })
            })
            .clone()
    }

    fn save_plan(&self, value: Value, import: bool) -> Result<Value, String> {
        let mut plan: Plan = serde_json::from_value(value).map_err(|e| format!("Invalid plan: {e}"))?;
        if plan.id.is_empty() || import {
            plan.id = new_id();
        }
        for pair in &mut plan.pairs {
            if pair.id.is_empty() || import {
                pair.id = new_id();
            }
        }
        plan.name = plan.name.trim().to_string();
        validate_plan(&plan)?;
        self.mutate(|s| {
            if let Some(old) = s.plans.iter_mut().find(|p| p.id == plan.id) {
                // Two-way history only holds for the same folders and rules.
                if old.pairs != plan.pairs || old.method != plan.method || old.include != plan.include || old.exclude != plan.exclude {
                    s.baselines.remove(&plan.id);
                }
                *old = plan.clone();
            } else {
                s.plans.push(plan.clone());
            }
            s.last_plan_id = Some(plan.id.clone());
            Ok(())
        })?;
        to_json(plan)
    }

    fn save_connection(&self, args: &Value) -> Result<Value, String> {
        let mut c = args.get("connection").cloned().ok_or("Missing connection")?;
        let obj = c.as_object_mut().ok_or("Connection must be an object")?;
        let kind = obj.get("kind").and_then(Value::as_str).unwrap_or_default().to_string();
        if !providers::KINDS.contains(&kind.as_str()) {
            return Err(format!("Unsupported connection type: {kind}"));
        }
        let name = obj.get("name").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        if name.is_empty() {
            return Err("Connection name is required".into());
        }
        let id = match obj.get("id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => new_id(),
        };
        if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err("Invalid connection id".into());
        }
        for key in ["address", "user", "remote", "message"] {
            if !obj.get(key).is_some_and(Value::is_string) {
                obj.insert(key.into(), json!(""));
            }
        }
        if !obj.get("options").is_some_and(Value::is_object) {
            obj.insert("options".into(), json!({}));
        }
        if let Some(port) = obj.get("port") {
            if !port.is_null() && !port.as_u64().is_some_and(|p| (1..=65535).contains(&p)) {
                return Err("Port must be between 1 and 65535".into());
            }
        } else {
            obj.insert("port".into(), Value::Null);
        }
        // Never persist anything that looks like a secret.
        for key in ["secret", "password", "token"] {
            obj.remove(key);
        }
        obj.insert("id".into(), json!(id));
        obj.insert("name".into(), json!(name));
        obj.insert("status".into(), json!("not_tested"));
        obj.insert("last_checked".into(), Value::Null);
        obj.insert("message".into(), json!(""));
        if let Some(secret) = args.get("secret").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            credentials::set(&id, secret)?;
        }
        self.mutate(|s| {
            match s.connections.iter_mut().find(|x| x.get("id").and_then(Value::as_str) == Some(&id)) {
                Some(existing) => *existing = c.clone(),
                None => s.connections.push(c.clone()),
            }
            Ok(())
        })?;
        Ok(c)
    }

    fn plan(&self, plan_id: &str) -> Result<(Plan, Vec<Value>), String> {
        let state = self.state()?;
        let plan = state.saved.plans.iter().find(|p| p.id == plan_id).cloned().ok_or("Plan not found")?;
        Ok((plan, state.saved.connections.clone()))
    }

    fn validate_roots(&self, provider: &Provider, plan: &Plan) -> Result<(), String> {
        let roots: Vec<&str> = plan.pairs.iter().flat_map(|p| [p.left.as_str(), p.right.as_str()]).collect();
        for root in &roots {
            provider.check_root(root)?;
            if let Some(path) = provider.local_path(root) {
                let path = fs::canonicalize(&path).map_err(|e| e.to_string())?;
                if path.starts_with(&self.inner.dir) || self.inner.dir.starts_with(&path) {
                    return Err(format!("{} overlaps Backurau's own data folder", path.display()));
                }
            }
        }
        for pair in &plan.pairs {
            provider.check_pair(&pair.left, &pair.right)?;
        }
        Ok(())
    }

    fn list_pair(provider: &Provider, plan: &Plan, pair: &Pair) -> Result<(Rules, providers::Listing, providers::Listing), String> {
        let rules = Rules::new(plan, pair)?;
        let hash = rules.method == "content";
        let prune = |path: &str, is_dir: bool| rules.excluded(path, is_dir).is_some();
        let left = provider.list(&pair.left, hash, &prune)?;
        let right = provider.list(&pair.right, hash, &prune)?;
        Ok((rules, left, right))
    }

    pub fn compare(&self, plan_id: &str) -> Result<Comparison, String> {
        let (plan, connections) = self.plan(plan_id)?;
        validate_plan(&plan)?;
        let baselines = self.state()?.saved.baselines.get(plan_id).cloned().unwrap_or_default();
        let provider = Provider::new(json!(connections));
        self.validate_roots(&provider, &plan)?;
        let mut comparison = Comparison { id: new_id(), plan_id: plan.id.clone(), created: now(), rows: vec![], totals: Totals::default(), warnings: vec![] };
        let mut row_number = 0;
        for pair in &plan.pairs {
            let (rules, left, right) = Self::list_pair(&provider, &plan, pair)?;
            comparison.warnings.extend(left.warnings.into_iter().map(|w| format!("{}: {w}", pair.left)));
            comparison.warnings.extend(right.warnings.into_iter().map(|w| format!("{}: {w}", pair.right)));
            let empty = BTreeMap::new();
            let baseline = baselines.get(&pair.id).unwrap_or(&empty);
            let paths: BTreeSet<&String> = left.tree.keys().chain(right.tree.keys()).collect();
            let mut excluded_dirs: Vec<String> = vec![];
            for path in paths {
                if !safe_relative(path) {
                    return Err(format!("Unsafe path from provider: {path}"));
                }
                let (l, r) = (left.tree.get(path), right.tree.get(path));
                let is_dir = l.or(r).is_some_and(|m| m.is_dir);
                let under_excluded = excluded_dirs.iter().any(|d| path.starts_with(d.as_str()));
                let (status, action, reason) = if under_excluded {
                    continue;
                } else if let Some(reason) = rules.excluded(path, is_dir) {
                    if is_dir {
                        excluded_dirs.push(format!("{path}/"));
                    }
                    ("excluded".into(), "skip".into(), Some(reason))
                } else {
                    decide(&plan, &rules, l, r, baseline.get(path))
                };
                let totals = &mut comparison.totals;
                match status.as_str() {
                    "added" => totals.added += 1,
                    "updated" => totals.updated += 1,
                    "deleted" => totals.deleted += 1,
                    "unchanged" => totals.unchanged += 1,
                    "conflict" => totals.conflicts += 1,
                    _ => {}
                }
                totals.bytes += match action.as_str() {
                    "copy_right" | "both" => l.map_or(0, |m| m.size),
                    "copy_left" => r.map_or(0, |m| m.size),
                    _ => 0,
                };
                row_number += 1;
                comparison.rows.push(Row {
                    id: format!("r{row_number}"),
                    pair_id: pair.id.clone(),
                    path: path.clone(),
                    left: l.cloned(),
                    right: r.cloned(),
                    selected: !matches!(action.as_str(), "skip" | "equal"),
                    status,
                    action,
                    reason,
                });
            }
        }
        if plan.engine == "rsync" && !providers::rsync_available() {
            comparison.warnings.push("rsync is not installed; the native engine will copy files.".into());
        }
        let mut state = self.state()?;
        if state.previews.len() >= 10 {
            if let Some(oldest) = state.previews.iter().min_by_key(|(_, p)| p.comparison.created).map(|(k, _)| k.clone()) {
                state.previews.remove(&oldest);
            }
        }
        state.previews.insert(comparison.id.clone(), Preview { comparison: comparison.clone(), plan });
        Ok(comparison)
    }

    /// Executes the selected rows of a comparison after checking that nothing changed since it was made.
    pub fn run(&self, comparison_id: &str, selected: &[String], resolutions: &BTreeMap<String, String>, confirm: bool, trigger: &str) -> Result<Run, String> {
        let _guard = self.inner.run_lock.try_lock().map_err(|_| "Another run is active. Wait for it or cancel it in Activity.")?;
        let preview = self.state()?.previews.get(comparison_id).cloned().ok_or("This comparison has expired. Compare again.")?;
        let (plan, connections) = self.plan(&preview.plan.id)?;
        if plan != preview.plan {
            return Err("The plan changed after this comparison. Compare again.".into());
        }
        if selected.is_empty() {
            return Err("Nothing is selected to run.".into());
        }
        let chosen: BTreeSet<&str> = selected.iter().map(String::as_str).collect();
        let mut rows: Vec<Row> = preview.comparison.rows.iter().filter(|r| chosen.contains(r.id.as_str())).cloned().collect();
        if rows.len() != chosen.len() {
            return Err("The selection does not match this comparison. Compare again.".into());
        }
        for row in &mut rows {
            if let Some(choice) = resolutions.get(&row.id) {
                if row.status != "conflict" {
                    return Err(format!("{} is not a conflict", row.path));
                }
                row.action = resolve(choice, row.left.as_ref(), row.right.as_ref())?;
                row.reason = Some(format!("Resolved for this run: {}", choice_label(choice)));
            }
        }
        let destructive = rows.iter().filter(|r| is_destructive(r)).count();
        if destructive > 0 && !confirm {
            return Err(format!("{destructive} selected actions overwrite or delete files. Confirm to continue."));
        }

        // Revalidate: roots must still be reachable and every selected path unchanged.
        let provider = Provider::new(json!(connections));
        self.validate_roots(&provider, &plan)?;
        let mut current: BTreeMap<String, (Tree, Tree)> = BTreeMap::new();
        for pair in plan.pairs.iter().filter(|p| rows.iter().any(|r| r.pair_id == p.id)) {
            let (_, left, right) = Self::list_pair(&provider, &plan, pair)?;
            current.insert(pair.id.clone(), (left.tree, right.tree));
        }
        for row in &rows {
            let (left, right) = &current[&row.pair_id];
            if left.get(&row.path) != row.left.as_ref() || right.get(&row.path) != row.right.as_ref() {
                return Err(format!("{} changed after the comparison. Compare again.", row.path));
            }
        }
        self.execute(&plan, &provider, rows, preview.comparison.warnings.clone(), trigger)
    }

    fn execute(&self, plan: &Plan, provider: &Provider, mut rows: Vec<Row>, warnings: Vec<String>, trigger: &str) -> Result<Run, String> {
        let started_at = Instant::now();
        let mut run = Run {
            id: new_id(),
            plan_id: plan.id.clone(),
            plan_name: plan.name.clone(),
            started: now(),
            finished: None,
            status: "running".into(),
            counts: Counts::default(),
            bytes: 0,
            duration_ms: 0,
            errors: vec![],
            warnings,
            actions: vec![],
            versions: vec![],
            snapshot_state: if plan.snapshot_mode == "versions" { "available" } else { "reports_only" }.into(),
            trigger: trigger.into(),
        };
        self.mutate(|s| {
            s.runs.insert(0, run.clone());
            Ok(())
        })?;
        self.inner.cancel.store(false, Ordering::SeqCst);
        // Parents are created before children; deletions run deepest-first.
        rows.sort_by(|a, b| {
            let (da, db) = (deletes(a), deletes(b));
            da.cmp(&db).then_with(|| if da { b.path.cmp(&a.path) } else { a.path.cmp(&b.path) })
        });
        let total = rows.len();
        self.set_job(Some(Job { id: run.id.clone(), plan_id: plan.id.clone(), status: "running".into(), completed: 0, total, bytes: 0, current_path: String::new() }));
        self.log("info", format!("Started {} ({total} selected actions)", plan.name));
        let version_dir = self.inner.dir.join("versions").join(&run.id);
        let mut canceled = false;
        for (index, row) in rows.iter().enumerate() {
            if self.inner.cancel.load(Ordering::SeqCst) {
                canceled = true;
                break;
            }
            self.update_job(|job| {
                job.completed = index;
                job.current_path = row.path.clone();
            });
            let pair = plan.pairs.iter().find(|p| p.id == row.pair_id).ok_or("Pair missing")?;
            let outcome = self.apply(plan, provider, pair, row, &version_dir, &mut run);
            let (result, detail) = match &outcome {
                Ok(bytes) => {
                    run.bytes += bytes;
                    self.update_job(|job| job.bytes += bytes);
                    ("done", None)
                }
                Err(e) => {
                    run.counts.failed += 1;
                    run.errors.push(format!("{}: {e}", row.path));
                    self.log("error", format!("{}: {e}", row.path));
                    ("failed", Some(e.clone()))
                }
            };
            if outcome.is_ok() {
                let counts = &mut run.counts;
                match row.action.as_str() {
                    "skip" | "equal" | "conflict" if row.status == "conflict" => counts.conflicts += 1,
                    "skip" | "equal" | "conflict" => counts.skipped += 1,
                    "delete_left" | "delete_right" => counts.deleted += 1,
                    _ if row.status == "updated" => counts.updated += 1,
                    _ => counts.copied += 1,
                }
            }
            if run.actions.len() < MAX_ACTIONS_PER_RUN {
                run.actions.push(json!({"path": row.path, "pair_id": row.pair_id, "status": row.status, "action": row.action, "result": result, "error": detail}));
            }
        }
        if rows.len() > MAX_ACTIONS_PER_RUN {
            run.warnings.push(format!("Report lists the first {MAX_ACTIONS_PER_RUN} of {} actions.", rows.len()));
        }
        if run.counts.conflicts > 0 {
            run.warnings.push(format!("{} conflicts were skipped. Resolve them in Compare.", run.counts.conflicts));
        }
        let attempted = run.counts.copied + run.counts.updated + run.counts.deleted;
        run.status = if canceled {
            "canceled"
        } else if run.counts.failed > 0 && attempted == 0 {
            "failed"
        } else if run.counts.conflicts > 0 {
            "completed_with_conflicts"
        } else if run.counts.failed > 0 || !run.warnings.is_empty() {
            "completed_with_warnings"
        } else {
            "completed"
        }
        .into();
        if canceled {
            run.warnings.push("Canceled. Finished actions were kept; nothing was rolled back.".into());
        }
        run.finished = Some(now());
        run.duration_ms = started_at.elapsed().as_millis() as u64;

        // Remember the agreed state of every path that now matches, for two-way change detection.
        let new_baselines = if plan.mode == "two_way" || plan.pairs.iter().any(|p| p.overrides.as_ref().and_then(|o| o.mode.as_deref()) == Some("two_way")) {
            self.snapshot_baselines(plan, provider).map_err(|e| run.warnings.push(format!("Two-way history not updated: {e}"))).ok()
        } else {
            None
        };
        let dir = self.inner.dir.clone();
        let final_run = run.clone();
        self.mutate(|s| {
            if let Some(slot) = s.runs.iter_mut().find(|r| r.id == final_run.id) {
                *slot = final_run.clone();
            }
            if let Some(update) = &new_baselines {
                let plan_baselines = s.baselines.entry(plan.id.clone()).or_default();
                for (pair_id, entries) in update {
                    let pair_baseline = plan_baselines.entry(pair_id.clone()).or_default();
                    for (path, entry) in entries {
                        match entry {
                            Some(entry) => {
                                pair_baseline.insert(path.clone(), entry.clone());
                            }
                            None => {
                                pair_baseline.remove(path);
                            }
                        }
                    }
                }
            }
            apply_retention(&dir, s, plan);
            s.runs.truncate(MAX_RUNS);
            Ok(())
        })?;
        self.set_job(None);
        let level = if run.status == "completed" { "info" } else { "warning" };
        self.log(level, format!("{}: {} ({} copied, {} updated, {} deleted, {} failed)", plan.name, run.status.replace('_', " "), run.counts.copied, run.counts.updated, run.counts.deleted, run.counts.failed));
        Ok(run)
    }

    /// Paths where both sides agree become the new baseline; paths gone from both are forgotten;
    /// paths that still differ keep their previous baseline so they stay conflicts.
    fn snapshot_baselines(&self, plan: &Plan, provider: &Provider) -> Result<BTreeMap<String, BTreeMap<String, Option<BaselineEntry>>>, String> {
        let mut out = BTreeMap::new();
        for pair in &plan.pairs {
            let (rules, left, right) = Self::list_pair(provider, plan, pair)?;
            let mut entries = BTreeMap::new();
            let paths: BTreeSet<&String> = left.tree.keys().chain(right.tree.keys()).collect();
            for path in paths {
                let (l, r) = (left.tree.get(path), right.tree.get(path));
                if let (Some(a), Some(b)) = (l, r) {
                    if same(a, b, &rules.method) {
                        entries.insert(path.clone(), Some(BaselineEntry { left: Some(a.clone()), right: Some(b.clone()) }));
                    }
                }
            }
            // Forget baseline paths that no longer exist on either side.
            if let Some(old) = self.state()?.saved.baselines.get(&plan.id).and_then(|b| b.get(&pair.id)) {
                for path in old.keys() {
                    if !left.tree.contains_key(path) && !right.tree.contains_key(path) {
                        entries.insert(path.clone(), None);
                    }
                }
            }
            out.insert(pair.id.clone(), entries);
        }
        Ok(out)
    }

    fn apply(&self, plan: &Plan, provider: &Provider, pair: &Pair, row: &Row, version_dir: &Path, run: &mut Run) -> Result<u64, String> {
        let keep_versions = plan.snapshot_mode == "versions";
        let copy = |from: &str, to: &str, overwrite: bool| {
            if plan.engine == "rsync" && providers::rsync_available() {
                provider.copy_rsync(from, &row.path, to, &row.path, overwrite)
            } else {
                provider.copy(from, &row.path, to, &row.path, overwrite)
            }
        };
        let save_version = |root: &str, meta: &FileMeta, run: &mut Run| -> Result<(), String> {
            if !keep_versions || meta.is_dir {
                return Ok(());
            }
            fs::create_dir_all(version_dir).map_err(|e| format!("Cannot create version folder: {e}"))?;
            let id = new_id();
            // A version that cannot be saved blocks the change it was meant to protect.
            provider.copy(root, &row.path, &version_dir.to_string_lossy(), &id, false).map_err(|e| format!("Version not saved, file left unchanged: {e}"))?;
            run.versions.push(Version { id, path: row.path.clone(), original_location: root.to_string(), size: meta.size, saved_at: now(), pair_id: pair.id.clone() });
            Ok(())
        };
        match row.action.as_str() {
            "skip" | "equal" | "conflict" => Ok(0),
            "copy_right" | "copy_left" => {
                let (from, to, src, dst) = if row.action == "copy_right" {
                    (&pair.left, &pair.right, row.left.as_ref(), row.right.as_ref())
                } else {
                    (&pair.right, &pair.left, row.right.as_ref(), row.left.as_ref())
                };
                let src = src.ok_or("Nothing to copy")?;
                if src.is_dir {
                    return provider.mkdir(to, &row.path).map(|_| 0);
                }
                if let Some(existing) = dst {
                    save_version(to, existing, run)?;
                }
                copy(from, to, dst.is_some())
            }
            "delete_right" | "delete_left" => {
                let (root, meta) = if row.action == "delete_right" { (&pair.right, row.right.as_ref()) } else { (&pair.left, row.left.as_ref()) };
                let meta = meta.ok_or("Nothing to delete")?;
                save_version(root, meta, run)?;
                provider.remove(root, &row.path, meta.is_dir).map(|_| 0)
            }
            "both" => {
                // Keep both: the right version is kept under a conflict name on both sides, then left wins the original name.
                let (l, r) = (row.left.as_ref().ok_or("Missing left file")?, row.right.as_ref().ok_or("Missing right file")?);
                if l.is_dir || r.is_dir {
                    return Err("Keep both is only available for files".into());
                }
                let alt = conflict_name(&row.path, run.started);
                save_version(&pair.right, r, run)?;
                provider.copy(&pair.right, &row.path, &pair.right, &alt, false)?;
                provider.copy(&pair.right, &row.path, &pair.left, &alt, false)?;
                copy(&pair.left, &pair.right, true)
            }
            other => Err(format!("Unknown action: {other}")),
        }
    }

    fn set_job(&self, job: Option<Job>) {
        if let Ok(mut state) = self.state() {
            state.active = job;
        }
    }

    fn update_job(&self, f: impl FnOnce(&mut Job)) {
        if let Ok(mut state) = self.state() {
            if let Some(job) = state.active.as_mut() {
                f(job);
            }
        }
    }

    fn restore(&self, args: &Value) -> Result<Value, String> {
        let _guard = self.inner.run_lock.try_lock().map_err(|_| "Wait for the active run to finish")?;
        let run_id = field(args, "run_id")?;
        let target = field(args, "target")?;
        let overwrite = args.get("overwrite").and_then(Value::as_bool).unwrap_or(false);
        let ids: BTreeSet<String> = serde_json::from_value(args.get("version_ids").cloned().unwrap_or(json!([]))).map_err(|e| e.to_string())?;
        if ids.is_empty() {
            return Err("Select at least one saved version".into());
        }
        let run = self.state()?.saved.runs.iter().find(|r| r.id == run_id).cloned().ok_or("Run not found")?;
        if run.snapshot_state != "available" {
            return Err(match run.snapshot_state.as_str() {
                "reports_only" => "This run kept a report only; no file data was saved.",
                "pruned" => "These saved versions were removed by retention.",
                _ => "Saved versions for this run are missing from disk.",
            }
            .into());
        }
        let target_path = Path::new(target);
        if !target_path.is_absolute() || !target_path.is_dir() {
            return Err("Choose an existing folder to restore into".into());
        }
        let target_path = fs::canonicalize(target_path).map_err(|e| e.to_string())?;
        if target_path.starts_with(&self.inner.dir) {
            return Err("Cannot restore into Backurau's data folder".into());
        }
        let provider = Provider::new(json!([]));
        let version_root = self.inner.dir.join("versions").join(&run.id);
        let (mut restored, mut skipped, mut errors) = (0, vec![], vec![]);
        for version in run.versions.iter().filter(|v| ids.contains(&v.id)) {
            if !safe_relative(&version.path) {
                errors.push(format!("{}: unsafe path", version.path));
                continue;
            }
            if !overwrite && fs::symlink_metadata(target_path.join(&version.path)).is_ok() {
                skipped.push(version.path.clone());
                continue;
            }
            match provider.copy(&version_root.to_string_lossy(), &version.id, &target_path.to_string_lossy(), &version.path, overwrite) {
                Ok(_) => restored += 1,
                Err(e) => errors.push(format!("{}: {e}", version.path)),
            }
        }
        self.log(if errors.is_empty() { "info" } else { "error" }, format!("Restored {restored} files into {}", target_path.display()));
        Ok(json!({"restored": restored, "target": target_path, "skipped": skipped, "errors": errors}))
    }

    /// Runs due automation. Adapters call this every few seconds from a background thread.
    pub fn tick(&self) -> Result<(), String> {
        let plans: Vec<Plan> = self.state()?.saved.plans.iter().filter(|p| p.schedule.enabled).cloned().collect();
        for plan in plans {
            if let Some(reason) = self.due(&plan)? {
                if self.inner.run_lock.try_lock().is_err() {
                    let mut state = self.state()?;
                    if !state.queued.contains(&plan.id) {
                        state.queued.push(plan.id.clone());
                    }
                    continue;
                }
                self.state()?.queued.retain(|id| id != &plan.id);
                self.state()?.triggers.entry(plan.id.clone()).or_default().last_attempt = now();
                self.log("info", format!("{}: automatic run ({reason})", plan.name));
                if let Err(e) = self.auto_run(&plan, reason) {
                    self.log("error", format!("{}: automatic run failed: {e}", plan.name));
                }
            }
        }
        Ok(())
    }

    fn due(&self, plan: &Plan) -> Result<Option<&'static str>, String> {
        let t = now();
        let last_run = self.state()?.saved.runs.iter().find(|r| r.plan_id == plan.id).map(|r| r.started);
        let last_attempt = self.state()?.triggers.get(&plan.id).map_or(0, |x| x.last_attempt);
        let queued = self.state()?.queued.contains(&plan.id);
        if queued {
            return Ok(Some("queued"));
        }
        let interval = plan.schedule.interval_minutes.max(1) * 60;
        if plan.schedule.interval_minutes > 0 && t.saturating_sub(last_run.unwrap_or(0).max(last_attempt)) >= interval {
            return Ok(Some("schedule"));
        }
        let provider = Provider::new(json!(self.state()?.saved.connections.clone()));
        if plan.schedule.on_available {
            let available = plan.pairs.iter().all(|p| provider.check_root(&p.left).is_ok() && provider.check_root(&p.right).is_ok());
            let previous = self.state()?.triggers.entry(plan.id.clone()).or_default().available.replace(available);
            if available && previous == Some(false) {
                return Ok(Some("locations available"));
            }
        }
        if plan.schedule.on_change {
            let last_poll = self.state()?.triggers.get(&plan.id).map_or(0, |x| x.last_poll);
            if t.saturating_sub(last_poll) >= CHANGE_POLL_SECONDS {
                let fingerprint = plan
                    .pairs
                    .iter()
                    .map(|p| {
                        let rules = Rules::new(plan, p).ok()?;
                        let tree = provider.list(&p.left, false, &|path, dir| rules.excluded(path, dir).is_some()).ok()?.tree;
                        serde_json::to_string(&tree).ok()
                    })
                    .collect::<Option<Vec<_>>>()
                    .map(|parts| parts.join("\n"));
                let mut state = self.state()?;
                let trig = state.triggers.entry(plan.id.clone()).or_default();
                trig.last_poll = t;
                if let Some(fp) = fingerprint {
                    let previous = trig.fingerprint.replace(fp.clone());
                    // Run once a change has settled for one full poll interval.
                    if previous.as_ref().is_some_and(|p| p != &fp) {
                        trig.changed = true;
                    } else if trig.changed {
                        trig.changed = false;
                        return Ok(Some("source changed"));
                    }
                }
            }
        }
        Ok(None)
    }

    /// Unattended run: conflicts without a saved plan rule are skipped and reported.
    fn auto_run(&self, plan: &Plan, reason: &str) -> Result<Run, String> {
        let comparison = match self.compare(&plan.id) {
            Ok(c) => c,
            Err(e) => {
                let run = Run {
                    id: new_id(),
                    plan_id: plan.id.clone(),
                    plan_name: plan.name.clone(),
                    started: now(),
                    finished: Some(now()),
                    status: "failed".into(),
                    counts: Counts::default(),
                    bytes: 0,
                    duration_ms: 0,
                    errors: vec![e.clone()],
                    warnings: vec![],
                    actions: vec![],
                    versions: vec![],
                    snapshot_state: "reports_only".into(),
                    trigger: reason.into(),
                };
                self.mutate(|s| {
                    s.runs.insert(0, run.clone());
                    s.runs.truncate(MAX_RUNS);
                    Ok(())
                })?;
                return Err(e);
            }
        };
        let selected: Vec<String> = comparison.rows.iter().filter(|r| r.selected).map(|r| r.id.clone()).collect();
        if selected.is_empty() {
            self.log("info", format!("{}: nothing to do", plan.name));
            return Err("Nothing to do".into());
        }
        self.run(&comparison.id, &selected, &BTreeMap::new(), true, reason)
    }
}

fn summary(run: &Run) -> Run {
    let mut run = run.clone();
    run.actions.clear();
    run
}

fn merge(mut base: Value, overlay: Value) -> Value {
    if let (Some(base_obj), Value::Object(over)) = (base.as_object_mut(), overlay) {
        for (key, value) in over {
            let merged = match base_obj.remove(&key) {
                Some(existing) if existing.is_object() && value.is_object() => merge(existing, value),
                _ => value,
            };
            base_obj.insert(key, merged);
        }
    }
    base
}

fn validate_settings(s: &Value) -> Result<(), String> {
    let one_of = |key: &str, allowed: &[&str]| {
        let value = s.get(key).and_then(Value::as_str).unwrap_or_default();
        if allowed.contains(&value) { Ok(()) } else { Err(format!("Invalid {key}: {value}")) }
    };
    one_of("theme", &["light", "dark", "system"])?;
    one_of("language", &["en"])?;
    one_of("density", &["comfortable", "compact"])?;
    let port = s.pointer("/service/port").and_then(Value::as_u64).unwrap_or(0);
    if !(1024..=65535).contains(&port) {
        return Err("Service port must be between 1024 and 65535".into());
    }
    Ok(())
}

fn validate_plan(plan: &Plan) -> Result<(), String> {
    if plan.name.is_empty() || plan.name.len() > 120 {
        return Err("Plan name must be 1-120 characters".into());
    }
    if plan.pairs.is_empty() {
        return Err("Add at least one folder pair".into());
    }
    let check = |name: &str, value: &str, allowed: &[&str]| {
        if allowed.contains(&value) { Ok(()) } else { Err(format!("Invalid {name}: {value}")) }
    };
    check("mode", &plan.mode, &["mirror", "update", "two_way", "custom"])?;
    check("method", &plan.method, &["time_size", "content"])?;
    check("conflict policy", &plan.conflict_policy, &["ask", "skip", "left", "right", "both"])?;
    check("snapshot mode", &plan.snapshot_mode, &["versions", "reports"])?;
    check("engine", &plan.engine, &["native", "rsync"])?;
    check("custom left-only action", &plan.custom.left_only, &["copy_right", "skip"])?;
    check("custom right-only action", &plan.custom.right_only, &["copy_left", "delete_right", "skip"])?;
    check("custom different action", &plan.custom.different, &["copy_right", "copy_left", "skip", "conflict"])?;
    if !(1..=1000).contains(&plan.retention) {
        return Err("Keep between 1 and 1000 snapshots".into());
    }
    for pair in &plan.pairs {
        if pair.left.trim().is_empty() || pair.right.trim().is_empty() {
            return Err("Each folder pair needs a source and a destination".into());
        }
        if pair.left == pair.right {
            return Err("Source and destination must differ".into());
        }
        Rules::new(plan, pair)?;
        if let Some(o) = &pair.overrides {
            if let Some(mode) = &o.mode {
                check("pair mode", mode, &["mirror", "update", "two_way", "custom"])?;
            }
            if let Some(method) = &o.method {
                check("pair method", method, &["time_size", "content"])?;
            }
        }
    }
    Ok(())
}

/// Plan settings after applying a pair's overrides.
struct Rules {
    mode: String,
    method: String,
    include: Vec<(String, Regex)>,
    exclude: Vec<(String, Regex)>,
}

impl Rules {
    fn new(plan: &Plan, pair: &Pair) -> Result<Self, String> {
        let o = pair.overrides.clone().unwrap_or_default();
        let compile = |patterns: &[String]| -> Result<Vec<(String, Regex)>, String> {
            patterns.iter().filter(|p| !p.trim().is_empty()).map(|p| Ok((p.clone(), pattern_regex(p)?))).collect()
        };
        Ok(Self {
            mode: o.mode.unwrap_or_else(|| plan.mode.clone()),
            method: o.method.unwrap_or_else(|| plan.method.clone()),
            include: compile(o.include.as_deref().unwrap_or(&plan.include))?,
            exclude: compile(o.exclude.as_deref().unwrap_or(&plan.exclude))?,
        })
    }

    /// Reason an item is filtered out. Exclude wins; include rules apply to files only.
    fn excluded(&self, path: &str, is_dir: bool) -> Option<String> {
        let name = path.rsplit('/').next().unwrap_or(path);
        let hit = |(pattern, re): &(String, Regex)| {
            let subject = if pattern.starts_with("regex:") || pattern.contains('/') { path } else { name };
            re.is_match(subject)
        };
        if let Some((pattern, _)) = self.exclude.iter().find(|r| hit(r)) {
            return Some(format!("Excluded by {pattern}"));
        }
        if !is_dir && !self.include.is_empty() && !self.include.iter().any(hit) {
            return Some("Not matched by include rules".into());
        }
        None
    }
}

/// `regex:<expr>` is a regular expression over the relative path; anything else is a glob
/// (`*` within a name, `**` across folders, `?` one character).
pub(crate) fn pattern_regex(pattern: &str) -> Result<Regex, String> {
    if let Some(expr) = pattern.strip_prefix("regex:") {
        return Regex::new(expr).map_err(|e| format!("Invalid regular expression {pattern}: {e}"));
    }
    let glob = pattern.trim_start_matches('/').trim_end_matches('/');
    let mut out = String::from("^");
    let chars: Vec<char> = glob.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' if chars.get(i + 1) == Some(&'*') => {
                out.push_str(".*");
                i += 1;
                if chars.get(i + 1) == Some(&'/') {
                    i += 1;
                    out.push_str("/?");
                }
            }
            '*' => out.push_str("[^/]*"),
            '?' => out.push_str("[^/]"),
            c => out.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    out.push('$');
    Regex::new(&out).map_err(|e| format!("Invalid pattern {pattern}: {e}"))
}

fn same(a: &FileMeta, b: &FileMeta, method: &str) -> bool {
    if a.is_dir || b.is_dir {
        return a.is_dir == b.is_dir;
    }
    match method {
        "content" => a.hash.is_some() && a.hash == b.hash,
        // Two seconds of tolerance covers FAT/exFAT timestamp resolution.
        _ => a.size == b.size && a.modified.abs_diff(b.modified) <= 2,
    }
}

type Decision = (String, String, Option<String>);

fn decision(status: &str, action: &str, reason: Option<&str>) -> Decision {
    (status.into(), action.into(), reason.map(String::from))
}

/// Status describes the effect of the planned action; action is what Run will do.
fn decide(plan: &Plan, rules: &Rules, l: Option<&FileMeta>, r: Option<&FileMeta>, base: Option<&BaselineEntry>) -> Decision {
    let to_right = |r: Option<&FileMeta>| decision(if r.is_some() { "updated" } else { "added" }, "copy_right", None);
    let to_left = |l: Option<&FileMeta>| decision(if l.is_some() { "updated" } else { "added" }, "copy_left", None);
    let conflict = |reason: &str| -> Decision {
        if plan.conflict_policy == "ask" {
            return decision("conflict", "conflict", Some(reason));
        }
        match resolve(&plan.conflict_policy, l, r) {
            Ok(action) => ("conflict".into(), action, Some(format!("{reason}. Plan rule: {}", choice_label(&plan.conflict_policy)))),
            Err(e) => ("conflict".into(), "skip".into(), Some(e)),
        }
    };
    if let (Some(a), Some(b)) = (l, r) {
        if a.is_dir != b.is_dir {
            return decision("conflict", if plan.conflict_policy == "ask" { "conflict" } else { "skip" }, Some("A file and a folder share this path"));
        }
        if same(a, b, &rules.method) {
            return decision("unchanged", "equal", None);
        }
    }
    match rules.mode.as_str() {
        "mirror" => match (l, r) {
            (Some(_), _) => to_right(r),
            (None, Some(_)) => decision("deleted", "delete_right", None),
            (None, None) => decision("unchanged", "equal", None),
        },
        "update" => match (l, r) {
            (Some(_), None) => to_right(None),
            (None, _) => decision("unchanged", "skip", Some("Update mode keeps destination-only items")),
            (Some(a), Some(b)) if a.modified >= b.modified => to_right(r),
            _ => decision("unchanged", "skip", Some("Destination is newer")),
        },
        "custom" => {
            let action = match (l, r) {
                (Some(_), None) => plan.custom.left_only.as_str(),
                (None, Some(_)) => plan.custom.right_only.as_str(),
                _ => plan.custom.different.as_str(),
            };
            match action {
                "copy_right" => to_right(r),
                "copy_left" => to_left(l),
                "delete_right" => decision("deleted", "delete_right", None),
                "conflict" => conflict("Custom rule asks for a decision"),
                _ => decision("unchanged", "skip", Some("Skipped by custom rule")),
            }
        }
        _ => {
            // Two-way: compare each side with the last agreed state.
            let Some(base) = base else {
                return match (l, r) {
                    (Some(_), None) => to_right(None),
                    (None, Some(_)) => to_left(None),
                    _ => conflict("Both sides differ and there is no earlier run to tell which changed"),
                };
            };
            let changed = |cur: Option<&FileMeta>, old: Option<&FileMeta>| match (cur, old) {
                (None, None) => false,
                (Some(a), Some(b)) => !same(a, b, &rules.method),
                _ => true,
            };
            match (changed(l, base.left.as_ref()), changed(r, base.right.as_ref())) {
                (true, false) if l.is_none() => decision("deleted", "delete_right", None),
                (true, false) => to_right(r),
                (false, true) if r.is_none() => decision("deleted", "delete_left", None),
                (false, true) => to_left(l),
                (true, true) => conflict("Both sides changed since the last run"),
                (false, false) => conflict("Difference left unresolved by an earlier run"),
            }
        }
    }
}

fn resolve(choice: &str, l: Option<&FileMeta>, r: Option<&FileMeta>) -> Result<String, String> {
    Ok(match (choice, l, r) {
        ("left", None, _) => "delete_right",
        ("left", Some(_), _) => "copy_right",
        ("right", _, None) => "delete_left",
        ("right", _, Some(_)) => "copy_left",
        ("both", Some(_), Some(_)) => "both",
        ("both", Some(_), None) => "copy_right",
        ("both", None, Some(_)) => "copy_left",
        ("skip", _, _) => "skip",
        _ => return Err(format!("Invalid conflict choice: {choice}")),
    }
    .into())
}

fn choice_label(choice: &str) -> &'static str {
    match choice {
        "left" => "keep source",
        "right" => "keep destination",
        "both" => "keep both",
        _ => "skip",
    }
}

fn deletes(row: &Row) -> bool {
    row.action.starts_with("delete_")
}

fn is_destructive(row: &Row) -> bool {
    match row.action.as_str() {
        "delete_left" | "delete_right" | "both" => true,
        "copy_right" => row.right.as_ref().is_some_and(|m| !m.is_dir),
        "copy_left" => row.left.as_ref().is_some_and(|m| !m.is_dir),
        _ => false,
    }
}

/// `dir/report.pdf` -> `dir/report (conflict 1730538900).pdf`
fn conflict_name(path: &str, ts: u64) -> String {
    let (dir, name) = path.rsplit_once('/').map_or(("", path), |(d, n)| (d, n));
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    let renamed = format!("{stem} (conflict {ts}){ext}");
    if dir.is_empty() { renamed } else { format!("{dir}/{renamed}") }
}

fn prune(dir: &Path, s: &mut SavedState, run_id: &str) -> Result<(), String> {
    let run = s.runs.iter_mut().find(|r| r.id == run_id).ok_or("Run not found")?;
    let path = dir.join("versions").join(&run.id);
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|e| format!("Cannot remove saved versions: {e}"))?;
    }
    if run.snapshot_state == "available" {
        run.snapshot_state = "pruned".into();
    }
    Ok(())
}

/// Keeps the newest `retention` runs with saved versions for this plan; older ones keep their report.
fn apply_retention(dir: &Path, s: &mut SavedState, plan: &Plan) {
    let expired: Vec<String> = s
        .runs
        .iter()
        .filter(|r| r.plan_id == plan.id && r.snapshot_state == "available" && !r.versions.is_empty())
        .skip(plan.retention)
        .map(|r| r.id.clone())
        .collect();
    for id in expired {
        let _ = prune(dir, s, &id);
    }
}
