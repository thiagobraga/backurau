//! Plan, comparison and run records. Field names are the JSON contract in `.specs/IMPLEMENTATION.md`.
use crate::providers::FileMeta;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub pairs: Vec<Pair>,
    pub mode: String,
    pub method: String,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub conflict_policy: String,
    pub snapshot_mode: String,
    pub retention: usize,
    pub schedule: Schedule,
    pub custom: Custom,
    pub engine: String,
}

impl Default for Plan {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "New plan".into(),
            pairs: vec![],
            mode: "update".into(),
            method: "time_size".into(),
            include: vec![],
            exclude: vec![],
            conflict_policy: "ask".into(),
            snapshot_mode: "versions".into(),
            retention: 10,
            schedule: Schedule::default(),
            custom: Custom::default(),
            engine: "native".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Pair {
    #[serde(default)]
    pub id: String,
    pub left: String,
    pub right: String,
    #[serde(default)]
    pub overrides: Option<Overrides>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Overrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Schedule {
    pub enabled: bool,
    pub interval_minutes: u64,
    pub on_change: bool,
    pub on_available: bool,
}

impl Default for Schedule {
    fn default() -> Self {
        Self { enabled: false, interval_minutes: 60, on_change: false, on_available: false }
    }
}

/// Action per comparison category when `mode == "custom"`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Custom {
    pub left_only: String,
    pub right_only: String,
    pub different: String,
}

impl Default for Custom {
    fn default() -> Self {
        Self { left_only: "copy_right".into(), right_only: "skip".into(), different: "copy_right".into() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Row {
    pub id: String,
    pub pair_id: String,
    pub path: String,
    pub left: Option<FileMeta>,
    pub right: Option<FileMeta>,
    pub status: String,
    pub action: String,
    pub selected: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Totals {
    pub added: u64,
    pub updated: u64,
    pub deleted: u64,
    pub unchanged: u64,
    pub conflicts: u64,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Comparison {
    pub id: String,
    pub plan_id: String,
    pub created: u64,
    pub rows: Vec<Row>,
    pub totals: Totals,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Counts {
    pub copied: u64,
    pub updated: u64,
    pub deleted: u64,
    pub skipped: u64,
    pub conflicts: u64,
    pub failed: u64,
}

/// A pre-change copy of one file, kept under `<data>/versions/<run>/<id>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Version {
    pub id: String,
    pub path: String,
    pub original_location: String,
    pub size: u64,
    pub saved_at: u64,
    pub pair_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub plan_id: String,
    pub plan_name: String,
    pub started: u64,
    pub finished: Option<u64>,
    pub status: String,
    pub counts: Counts,
    pub bytes: u64,
    pub duration_ms: u64,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub actions: Vec<Value>,
    pub versions: Vec<Version>,
    pub snapshot_state: String,
    #[serde(default)]
    pub trigger: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub plan_id: String,
    pub status: String,
    pub completed: usize,
    pub total: usize,
    pub bytes: u64,
    pub current_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Log {
    pub ts: u64,
    pub level: String,
    pub message: String,
}

/// Last agreed state of one path in a two-way pair, used to tell which side changed.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BaselineEntry {
    pub left: Option<FileMeta>,
    pub right: Option<FileMeta>,
}

/// plan id -> pair id -> relative path -> baseline
pub type Baselines = BTreeMap<String, BTreeMap<String, BTreeMap<String, BaselineEntry>>>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct SavedState {
    pub schema: u32,
    pub plans: Vec<Plan>,
    pub last_plan_id: Option<String>,
    pub settings: Value,
    pub connections: Vec<Value>,
    pub runs: Vec<Run>,
    pub baselines: Baselines,
}

impl Default for SavedState {
    fn default() -> Self {
        Self {
            schema: 1,
            plans: vec![],
            last_plan_id: None,
            settings: default_settings(),
            connections: vec![],
            runs: vec![],
            baselines: BTreeMap::new(),
        }
    }
}

pub fn default_settings() -> Value {
    json!({
        "theme": "system", "language": "en", "density": "comfortable",
        "start_minimized": false, "run_in_background": false,
        "default_plan_location": "", "confirm_deletions": true,
        "notifications": {"enabled": true, "on_success": false, "on_error": true, "on_conflict": true},
        "security": {"credential_store": "os", "lock_on_exit": true},
        "service": {"enabled": false, "bind": "127.0.0.1", "port": 8787}
    })
}
