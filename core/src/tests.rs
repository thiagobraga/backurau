//! Engine behavior on throwaway folders under the system temp directory. Never touches user files.
use crate::{engine::pattern_regex, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

struct Fixture {
    root: PathBuf,
    engine: Engine,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("backurau-test-{}", uuid::Uuid::new_v4().simple()));
        for dir in ["left", "right", "data", "restore"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let engine = Engine::new(root.join("data")).unwrap();
        Self { root, engine }
    }
    fn left(&self) -> PathBuf {
        self.root.join("left")
    }
    fn right(&self) -> PathBuf {
        self.root.join("right")
    }
    fn call(&self, method: &str, args: Value) -> Value {
        self.engine.dispatch(method, args).unwrap_or_else(|e| panic!("{method} failed: {e}"))
    }
    fn plan(&self, mode: &str, extra: Value) -> String {
        let mut plan = json!({"name": "Test", "mode": mode, "pairs": [{"left": self.left(), "right": self.right()}]});
        if let (Some(p), Some(e)) = (plan.as_object_mut(), extra.as_object()) {
            p.extend(e.clone());
        }
        self.call("save_plan", json!({ "plan": plan }))["id"].as_str().unwrap().to_string()
    }
    fn compare(&self, plan_id: &str) -> Value {
        self.call("compare_plan", json!({ "plan_id": plan_id }))
    }
    /// Compares and runs every selected row, resolving conflicts with `choice` when given.
    fn sync(&self, plan_id: &str, choice: Option<&str>) -> Value {
        let c = self.compare(plan_id);
        let selected: Vec<Value> = rows(&c).iter().filter(|r| r["selected"] == true).map(|r| r["id"].clone()).collect();
        let resolutions: serde_json::Map<String, Value> = match choice {
            Some(choice) => rows(&c).iter().filter(|r| r["status"] == "conflict").map(|r| (r["id"].as_str().unwrap().to_string(), json!(choice))).collect(),
            None => Default::default(),
        };
        self.call("run_plan", json!({"comparison_id": c["id"], "selected": selected, "resolutions": resolutions, "confirm_destructive": true}))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn rows(c: &Value) -> &Vec<Value> {
    c["rows"].as_array().unwrap()
}

fn row<'a>(c: &'a Value, path: &str) -> &'a Value {
    rows(c).iter().find(|r| r["path"] == path).unwrap_or_else(|| panic!("no row {path}"))
}

fn write(path: &Path, content: &str, age_secs: u64) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
    let time = SystemTime::now() - Duration::from_secs(age_secs);
    fs::File::options().write(true).open(path).unwrap().set_modified(time).unwrap();
}

#[test]
fn mirror_previews_runs_saves_versions_and_restores() {
    let f = Fixture::new();
    write(&f.left().join("new.txt"), "new", 10);
    write(&f.left().join("docs/report.txt"), "version 2", 10);
    write(&f.right().join("docs/report.txt"), "version 1", 1000);
    write(&f.right().join("old.txt"), "old", 1000);
    write(&f.left().join("same.txt"), "same", 500);
    write(&f.right().join("same.txt"), "same", 500);
    let plan = f.plan("mirror", json!({}));
    let c = f.compare(&plan);
    assert_eq!(row(&c, "new.txt")["action"], "copy_right");
    assert_eq!(row(&c, "new.txt")["status"], "added");
    assert_eq!(row(&c, "docs/report.txt")["status"], "updated");
    assert_eq!(row(&c, "old.txt")["action"], "delete_right");
    assert_eq!(row(&c, "same.txt")["action"], "equal");
    assert_eq!(c["totals"]["deleted"], 1);
    // Nothing changes on disk until Run.
    assert!(f.right().join("old.txt").exists());

    let selected: Vec<Value> = rows(&c).iter().filter(|r| r["selected"] == true).map(|r| r["id"].clone()).collect();
    let err = f.engine.dispatch("run_plan", json!({"comparison_id": c["id"], "selected": selected, "confirm_destructive": false})).unwrap_err();
    assert!(err.contains("Confirm"), "{err}");
    let run = f.call("run_plan", json!({"comparison_id": c["id"], "selected": selected, "confirm_destructive": true}));
    assert_eq!(run["status"], "completed");
    assert_eq!(run["counts"]["copied"], 1);
    assert_eq!(run["counts"]["updated"], 1);
    assert_eq!(run["counts"]["deleted"], 1);
    assert_eq!(fs::read_to_string(f.right().join("docs/report.txt")).unwrap(), "version 2");
    assert!(!f.right().join("old.txt").exists());
    assert_eq!(run["versions"].as_array().unwrap().len(), 2);
    assert_eq!(run["snapshot_state"], "available");

    let ids: Vec<Value> = run["versions"].as_array().unwrap().iter().map(|v| v["id"].clone()).collect();
    let target = f.root.join("restore");
    let restored = f.call("restore_versions", json!({"run_id": run["id"], "version_ids": ids, "target": target, "overwrite": false}));
    assert_eq!(restored["restored"], 2);
    assert_eq!(fs::read_to_string(target.join("docs/report.txt")).unwrap(), "version 1");
    assert_eq!(fs::read_to_string(target.join("old.txt")).unwrap(), "old");
    // A second restore does not overwrite.
    let again = f.call("restore_versions", json!({"run_id": run["id"], "version_ids": ids, "target": target}));
    assert_eq!(again["restored"], 0);
    assert_eq!(again["skipped"].as_array().unwrap().len(), 2);

    let full = f.call("get_run", json!({"id": run["id"]}));
    assert!(!full["actions"].as_array().unwrap().is_empty());
    let after = f.compare(&plan);
    assert!(rows(&after).iter().all(|r| r["action"] == "equal"));
}

#[test]
fn update_mode_keeps_destination_only_and_newer_files() {
    let f = Fixture::new();
    write(&f.right().join("extra.txt"), "keep", 100);
    write(&f.left().join("a.txt"), "older", 1000);
    write(&f.right().join("a.txt"), "newer!", 10);
    let plan = f.plan("update", json!({}));
    let c = f.compare(&plan);
    assert_eq!(row(&c, "extra.txt")["action"], "skip");
    assert_eq!(row(&c, "a.txt")["action"], "skip");
    assert_eq!(row(&c, "a.txt")["reason"], "Destination is newer");
}

#[test]
fn two_way_uses_prior_state_and_reports_conflicts() {
    let f = Fixture::new();
    write(&f.left().join("l.txt"), "from left", 100);
    write(&f.right().join("r.txt"), "from right", 100);
    let plan = f.plan("two_way", json!({}));
    let run = f.sync(&plan, None);
    assert_eq!(run["status"], "completed");
    assert!(f.right().join("l.txt").exists() && f.left().join("r.txt").exists());

    // One side changes: propagate. Deletion on one side: propagate as delete.
    write(&f.left().join("l.txt"), "edited on left", 5);
    fs::remove_file(f.right().join("r.txt")).unwrap();
    let c = f.compare(&plan);
    assert_eq!(row(&c, "l.txt")["action"], "copy_right");
    assert_eq!(row(&c, "r.txt")["action"], "delete_left");
    f.sync(&plan, None);
    assert_eq!(fs::read_to_string(f.right().join("l.txt")).unwrap(), "edited on left");
    assert!(!f.left().join("r.txt").exists());

    // Both sides change: conflict, never a silent newest-wins.
    write(&f.left().join("l.txt"), "left again", 3);
    write(&f.right().join("l.txt"), "right again!", 1);
    let c = f.compare(&plan);
    assert_eq!(row(&c, "l.txt")["status"], "conflict");
    assert_eq!(row(&c, "l.txt")["action"], "conflict");
    let run = f.sync(&plan, None);
    assert_eq!(run["status"], "completed_with_conflicts");
    assert_eq!(run["counts"]["conflicts"], 1);
    // Still a conflict after an unresolved run.
    assert_eq!(row(&f.compare(&plan), "l.txt")["status"], "conflict");

    // Keep both: left wins the name, right is kept under a conflict name on both sides.
    let run = f.sync(&plan, Some("both"));
    assert_eq!(run["status"], "completed");
    assert_eq!(fs::read_to_string(f.right().join("l.txt")).unwrap(), "left again");
    let renamed: Vec<_> = fs::read_dir(f.left()).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().into_string().unwrap()).filter(|n| n.contains("conflict")).collect();
    assert_eq!(renamed.len(), 1, "{renamed:?}");
    assert_eq!(fs::read_to_string(f.right().join(&renamed[0])).unwrap(), "right again!");
}

#[test]
fn conflict_policy_skip_and_custom_rules() {
    let f = Fixture::new();
    write(&f.left().join("a.txt"), "aaa", 100);
    write(&f.right().join("a.txt"), "bbbb", 100);
    write(&f.right().join("only-right.txt"), "r", 100);
    write(&f.left().join("only-left.txt"), "l", 100);
    let plan = f.plan("custom", json!({"conflict_policy": "skip", "custom": {"left_only": "skip", "right_only": "copy_left", "different": "conflict"}}));
    let c = f.compare(&plan);
    assert_eq!(row(&c, "only-left.txt")["action"], "skip");
    assert_eq!(row(&c, "only-right.txt")["action"], "copy_left");
    assert_eq!(row(&c, "a.txt")["status"], "conflict");
    assert_eq!(row(&c, "a.txt")["action"], "skip");
}

#[test]
fn stale_preview_is_rejected() {
    let f = Fixture::new();
    write(&f.left().join("a.txt"), "one", 100);
    let plan = f.plan("mirror", json!({}));
    let c = f.compare(&plan);
    write(&f.left().join("a.txt"), "changed!", 1);
    let id = row(&c, "a.txt")["id"].clone();
    let err = f.engine.dispatch("run_plan", json!({"comparison_id": c["id"], "selected": [id], "confirm_destructive": true})).unwrap_err();
    assert!(err.contains("changed after the comparison"), "{err}");
    // Editing the plan also invalidates the preview.
    let c = f.compare(&plan);
    let mut saved = f.call("export_plan", json!({"id": plan}));
    saved["mode"] = json!("update");
    f.call("save_plan", json!({ "plan": saved }));
    let err = f.engine.dispatch("run_plan", json!({"comparison_id": c["id"], "selected": [rows(&c)[0]["id"]], "confirm_destructive": true})).unwrap_err();
    assert!(err.contains("plan changed"), "{err}");
}

#[test]
fn empty_selection_runs_nothing() {
    let f = Fixture::new();
    write(&f.left().join("a.txt"), "one", 100);
    let plan = f.plan("mirror", json!({}));
    let c = f.compare(&plan);
    let err = f.engine.dispatch("run_plan", json!({"comparison_id": c["id"], "selected": []})).unwrap_err();
    assert!(err.contains("Nothing is selected"));
    assert!(!f.right().join("a.txt").exists());
    // Partial selection runs only what was chosen.
    write(&f.left().join("b.txt"), "two", 100);
    let c = f.compare(&plan);
    f.call("run_plan", json!({"comparison_id": c["id"], "selected": [row(&c, "b.txt")["id"]]}));
    assert!(f.right().join("b.txt").exists() && !f.right().join("a.txt").exists());
}

#[test]
fn unavailable_and_overlapping_roots_are_errors_not_empty_trees() {
    let f = Fixture::new();
    write(&f.right().join("precious.txt"), "do not delete", 100);
    let plan = f.call("save_plan", json!({"plan": {"name": "Gone", "mode": "mirror", "pairs": [{"left": f.root.join("missing"), "right": f.right()}]}}));
    let err = f.engine.dispatch("compare_plan", json!({"plan_id": plan["id"]})).unwrap_err();
    assert!(err.contains("unavailable"), "{err}");

    let nested = f.call("save_plan", json!({"plan": {"name": "Nested", "pairs": [{"left": f.left(), "right": f.left().join("inner")}]}}));
    fs::create_dir_all(f.left().join("inner")).unwrap();
    let err = f.engine.dispatch("compare_plan", json!({"plan_id": nested["id"]})).unwrap_err();
    assert!(err.contains("overlap"), "{err}");

    let data = f.call("save_plan", json!({"plan": {"name": "Data", "pairs": [{"left": f.left(), "right": f.root.join("data")}]}}));
    let err = f.engine.dispatch("compare_plan", json!({"plan_id": data["id"]})).unwrap_err();
    assert!(err.contains("data folder"), "{err}");
    assert!(f.engine.dispatch("save_plan", json!({"plan": {"name": "Rel", "pairs": [{"left": "relative", "right": f.right()}]}})).is_ok());
}

#[cfg(unix)]
#[test]
fn symlinks_are_skipped_with_a_warning() {
    let f = Fixture::new();
    write(&f.root.join("outside/secret.txt"), "x", 100);
    std::os::unix::fs::symlink(f.root.join("outside"), f.left().join("link")).unwrap();
    write(&f.left().join("real.txt"), "y", 100);
    let plan = f.plan("mirror", json!({}));
    let c = f.compare(&plan);
    assert!(rows(&c).iter().all(|r| !r["path"].as_str().unwrap().starts_with("link")));
    assert!(c["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("Skipped symbolic link: link")));
}

#[test]
fn filters_explain_exclusions_and_prune_folders() {
    let f = Fixture::new();
    write(&f.left().join("keep.txt"), "k", 100);
    write(&f.left().join("cache/big.bin"), "b", 100);
    write(&f.left().join("notes.tmp"), "t", 100);
    write(&f.left().join("src/main.rs"), "m", 100);
    let plan = f.plan("mirror", json!({"exclude": ["cache", "*.tmp"], "include": ["regex:\\.(txt|rs)$"]}));
    let c = f.compare(&plan);
    assert_eq!(row(&c, "cache")["status"], "excluded");
    assert_eq!(row(&c, "cache")["reason"], "Excluded by cache");
    assert!(rows(&c).iter().all(|r| r["path"] != "cache/big.bin"));
    assert_eq!(row(&c, "notes.tmp")["reason"], "Excluded by *.tmp");
    assert_eq!(row(&c, "src/main.rs")["action"], "copy_right");
    assert_eq!(row(&c, "keep.txt")["action"], "copy_right");
    assert!(pattern_regex("**/*.log").unwrap().is_match("a/b/c.log"));
    assert!(pattern_regex("docs/*.md").unwrap().is_match("docs/x.md"));
    assert!(!pattern_regex("docs/*.md").unwrap().is_match("docs/a/x.md"));
    assert!(f.engine.dispatch("save_plan", json!({"plan": {"name": "Bad", "exclude": ["regex:("], "pairs": [{"left": f.left(), "right": f.right()}]}})).is_err());
}

#[test]
fn content_method_detects_same_size_same_time_edits() {
    let f = Fixture::new();
    write(&f.left().join("a.txt"), "aaaa", 100);
    write(&f.right().join("a.txt"), "bbbb", 100);
    let plan = f.plan("mirror", json!({}));
    assert_eq!(row(&f.compare(&plan), "a.txt")["action"], "equal");
    let plan = f.plan("mirror", json!({"method": "content"}));
    assert_eq!(row(&f.compare(&plan), "a.txt")["action"], "copy_right");
}

#[test]
fn retention_prunes_old_versions_but_keeps_reports() {
    let f = Fixture::new();
    let plan = f.plan("mirror", json!({"retention": 1}));
    for i in 0..3 {
        write(&f.left().join("a.txt"), &format!("v{i}{}", "!".repeat(i)), 100 - i as u64);
        if i == 0 {
            f.sync(&plan, None);
            continue;
        }
        f.sync(&plan, None);
    }
    let runs = f.call("list_runs", json!({}));
    let states: Vec<&str> = runs.as_array().unwrap().iter().map(|r| r["snapshot_state"].as_str().unwrap()).collect();
    assert_eq!(states[0], "available");
    assert_eq!(states[1], "pruned");
    let pruned = &runs[1];
    let err = f.engine.dispatch("restore_versions", json!({"run_id": pruned["id"], "version_ids": [pruned["versions"][0]["id"]], "target": f.root.join("restore")})).unwrap_err();
    assert!(err.contains("retention"), "{err}");

    let reports = f.plan("mirror", json!({"snapshot_mode": "reports"}));
    write(&f.left().join("b.txt"), "b", 1);
    let run = f.sync(&reports, None);
    assert_eq!(run["snapshot_state"], "reports_only");
}

#[test]
fn state_persists_and_interrupted_runs_are_recovered() {
    let root = std::env::temp_dir().join(format!("backurau-test-{}", uuid::Uuid::new_v4().simple()));
    let data = root.join("data");
    fs::create_dir_all(root.join("l")).unwrap();
    fs::create_dir_all(root.join("r")).unwrap();
    let engine = Engine::new(data.clone()).unwrap();
    assert!(Engine::new(data.clone()).is_err(), "second engine on the same data must be refused");
    let plan = engine.dispatch("save_plan", json!({"plan": {"name": "P", "pairs": [{"left": root.join("l"), "right": root.join("r")}]}})).unwrap()["id"].clone();
    drop(engine);
    let path = data.join("state-v1.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    state["runs"] = json!([{"id": "x1", "plan_id": plan, "plan_name": "P", "started": 1, "finished": null, "status": "running",
        "counts": {"copied": 0, "updated": 0, "deleted": 0, "skipped": 0, "conflicts": 0, "failed": 0}, "bytes": 0, "duration_ms": 0,
        "errors": [], "warnings": [], "actions": [], "versions": [], "snapshot_state": "reports_only"}]);
    fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
    let engine = Engine::new(data).unwrap();
    let s = engine.dispatch("get_state", json!({})).unwrap();
    assert_eq!(s["last_plan_id"], plan);
    assert_eq!(s["runs"][0]["status"], "interrupted");
    drop(engine);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn settings_connections_and_import_export() {
    let f = Fixture::new();
    let saved = f.call("save_settings", json!({"settings": {"theme": "dark", "service": {"port": 9000}}}));
    assert_eq!(saved["theme"], "dark");
    assert_eq!(saved["confirm_deletions"], true);
    assert!(f.engine.dispatch("save_settings", json!({"settings": {"theme": "neon"}})).is_err());

    let mount = f.root.join("mount");
    fs::create_dir_all(&mount).unwrap();
    let c = f.call("save_connection", json!({"connection": {"name": "Share", "kind": "smb", "address": mount, "password": "nope"}}));
    assert!(c.get("password").is_none());
    assert_eq!(c["status"], "not_tested");
    let tested = f.call("test_connection", json!({"id": c["id"]}));
    assert_eq!(tested["status"], "available");
    let plan = f.call("save_plan", json!({"plan": {"name": "Via connection", "pairs": [{"left": f.left(), "right": format!("connection://{}", c["id"].as_str().unwrap())}]}}));
    write(&f.left().join("a.txt"), "a", 10);
    f.sync(plan["id"].as_str().unwrap(), None);
    assert!(mount.join("a.txt").exists());
    assert!(f.engine.dispatch("delete_connection", json!({"id": c["id"]})).unwrap_err().contains("used by plan"));

    let exported = f.call("export_plan", json!({"id": plan["id"]}));
    let imported = f.call("import_plan", json!({ "plan": exported }));
    assert_ne!(imported["id"], plan["id"]);
    assert_eq!(f.call("get_state", json!({}))["plans"].as_array().unwrap().len(), 2);
    let state = fs::read_to_string(f.root.join("data/state-v1.json")).unwrap();
    assert!(!state.contains("nope"));
}

#[test]
fn cancel_flag_stops_between_operations() {
    let f = Fixture::new();
    for i in 0..30 {
        write(&f.left().join(format!("f{i}.txt")), "x", 10);
    }
    let plan = f.plan("mirror", json!({}));
    let c = f.compare(&plan);
    let ids: Vec<Value> = rows(&c).iter().map(|r| r["id"].clone()).collect();
    let engine = f.engine.clone();
    let canceller = std::thread::spawn(move || {
        for _ in 0..2000 {
            if engine.dispatch("get_activity", json!({})).unwrap()["active"].is_object() {
                engine.dispatch("cancel_run", json!({})).unwrap();
                return;
            }
            std::thread::yield_now();
        }
    });
    let run = f.call("run_plan", json!({"comparison_id": c["id"], "selected": ids}));
    canceller.join().unwrap();
    // The run may finish before cancel lands on a fast disk; either way the report must be truthful.
    let copied = run["counts"]["copied"].as_u64().unwrap();
    let on_disk = fs::read_dir(f.right()).unwrap().count() as u64;
    assert_eq!(copied, on_disk);
    if run["status"] == "canceled" {
        assert!(copied < 30);
    }
}
