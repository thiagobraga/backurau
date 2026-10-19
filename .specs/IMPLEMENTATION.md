# Backurau implementation contract

Source: `/home/thiago/Downloads/backurau/00..06-BACKURAU-*.md` and the existing DESIGN.md and supplied PNG concepts. User selected all four phases and approved React/Vite, shared Rust, rclone/rsync, OS credentials and loopback token-authenticated service. Preserve existing user configuration and archives. No synthetic runtime data.

## Architecture and ownership

- `core/`: new `backurau-core` Rust library. Shared desktop/service engine. Core owner owns all except `core/src/providers.rs` and `core/src/credentials.rs`.
- Providers owner owns those two modules, `docs/PROVIDERS.md`, provider test fixtures if needed under `core/tests/providers/`. Do not edit core Cargo.toml; send required dependencies to core owner.
- Transport owner owns `server/`, `tauri-app/src-tauri/`, `.github/workflows/`, `scripts/service-*`. Both adapters use the same engine.
- UI owner owns `tauri-app/src/`, `tauri-app/public/`, `tauri-app/ui/`, `tauri-app/index.html`, package files, Vite/TypeScript configs, and UI tests. Build emits `tauri-app/ui` for existing static/Tauri paths.
- Leader owns integration, documentation, Docker/tasks, acceptance tests and ledgers. Read files before editing. Preserve unrelated state. No git repository exists here.

## Engine interface (stable across owners)

`backurau_core::Engine::new(data_dir: PathBuf) -> Result<Self, String>`; cloneable and thread-safe.
`Engine::dispatch(&self, method: &str, args: serde_json::Value) -> Result<serde_json::Value, String>`.
`Engine::tick(&self) -> Result<(), String>` processes due automation, adapters call every 5s on a background thread. Long-running `run_plan` executes synchronously on the adapter's blocking worker; `get_activity` and `cancel_run` remain responsive. Each engine serializes runs; durable interrupted reports recovered on startup.
`backurau_core::default_data_dir() -> PathBuf` respects `BACKURAU_DATA_DIR`, platform config directories. OS credentials never in JSON, logs, exports or returned state.

Tauri exposes one `api(method: String, args: Value)` command and native `pick_folder` + window controls. Web exposes `POST /api/{method}`, JSON args and raw JSON result; failures JSON `{error: string}` with non-2xx. `GET /health` public. Bearer token required for all API methods. UI uses Tauri when present, otherwise same-origin HTTP and session-only token entry on 401. Never invent connected state. Web folder selection uses editable absolute paths. Desktop picker cancellation returns null.

## JSON contract

All fields snake_case; Unix timestamps in seconds; sizes bytes. IDs safe opaque strings. Requests below have object bodies. Return state unless stated otherwise.

`get_state {}` -> `{plans: Plan[], last_plan_id: string|null, settings: Settings, connections: Connection[], runs: Run[], capabilities: object}`.
`save_plan {plan: Plan}` -> Plan; `delete_plan {id}` -> null; `select_plan {id}` -> null.
`export_plan {id}` -> Plan; `import_plan {plan}` -> Plan with fresh identity.
Plan = `{id, name, pairs:[{id,left,right,overrides:null|{mode?,method?,include?,exclude?}}], mode:'mirror'|'update'|'two_way'|'custom', method:'time_size'|'content', include:string[], exclude:string[], conflict_policy:'ask'|'skip'|'left'|'right'|'both', snapshot_mode:'versions'|'reports', retention:10, schedule:{enabled:false,interval_minutes:60,on_change:false,on_available:false}, custom:{left_only:'copy_right',right_only:'skip',different:'copy_right'}, engine:'native'|'rsync'}`. Empty id on create. Paths may be local absolute or `connection://<id>/<relative>`.

`compare_plan {plan_id}` -> Comparison `{id,plan_id,created,rows:Row[],totals:{added,updated,deleted,unchanged,conflicts,bytes},warnings:string[]}`.
Row = `{id,pair_id,path,left:FileMeta|null,right:FileMeta|null,status:'added'|'updated'|'deleted'|'unchanged'|'conflict'|'excluded',action:'copy_right'|'copy_left'|'delete_right'|'delete_left'|'skip'|'equal'|'conflict'|'both',selected:bool,reason:string|null}`.
FileMeta = `{size:u64,modified:u64,is_dir:bool,hash:string|null}`.
`run_plan {comparison_id, selected:string[], resolutions:{[row_id]:'left'|'right'|'both'|'skip'}, confirm_destructive:bool}` -> Run. Empty selection executes nothing (never all). Core revalidates paths, settings and file state; stale previews rejected. Destructive actions require confirmation. UI review displays counts, bytes, actions, overwrites/deletes and unresolved conflicts.
`get_activity {}` -> `{active:Job|null,queued:string[],logs:Log[]}`; Job `{id,plan_id,status,completed,total,bytes,current_path}`; Log `{ts,level,message}`. `cancel_run {}` -> null.
Run = `{id,plan_id,plan_name,started,finished,status:'running'|'completed'|'completed_with_warnings'|'completed_with_conflicts'|'failed'|'canceled'|'interrupted',counts:{copied,updated,deleted,skipped,conflicts,failed},bytes,duration_ms,errors:string[],warnings:string[],actions:object[],versions:Version[],snapshot_state:'available'|'reports_only'|'pruned'|'unavailable'}`.
Version = `{id,path,original_location,size,saved_at,pair_id}`. Retained versions are pre-change files (not a full point-in-time tree); UI must disclose this. Preserve new source files as versions as well where needed for meaningful first backup restore.
`list_runs {}` -> Run[]; `get_run {id}` -> Run; `restore_versions {run_id,version_ids:string[],target:string,overwrite:false}` -> `{restored:number,target:string}`. Target is explicit existing directory; preserve relative pair paths; selected folder expands to retained descendants in UI. Restore validates paths and never follows symlinks. `prune_snapshot {id}` -> null (keeps report).
`save_settings {settings}` -> Settings. Settings = `{theme:'light'|'dark'|'system',language:'en',density:'comfortable'|'compact',start_minimized:false,run_in_background:false,default_plan_location:'',confirm_deletions:true,notifications:{enabled:true,on_success:false,on_error:true,on_conflict:true},security:{credential_store:'os',lock_on_exit:true},service:{enabled:false,bind:'127.0.0.1',port:8787}}`. Platform operations must be real or clearly unsupported; never claim a saved preference changes an unavailable platform capability.
`save_connection {connection,secret?:string}` -> Connection; `delete_connection {id}` -> null; `test_connection {id}` -> Connection.
Connection = `{id,name,kind:'local'|'smb'|'sftp'|'s3'|'webdav'|'gdrive'|'onedrive'|'rclone',address,user:'',port:null|number,remote:'',status:'not_tested'|'available'|'needs_authentication'|'unavailable',last_checked:null|number,message:'',options:{}}`. Credentials stored only by OS store; configured rclone remotes can supply OAuth. SMB/NFS use mounted paths; report accurately. No network calls on mere form edits.

## Provider module contract (core consumes)

`pub struct FileMeta { pub size:u64, pub modified:u64, pub is_dir:bool, pub hash:Option<String> }` derive Serialize, Deserialize, Clone, Debug, PartialEq, Eq. `pub struct Provider { ... }` constructed `Provider::new(connections: serde_json::Value)`.
`Provider::list(&self, root:&str, content:bool) -> Result<BTreeMap<String,FileMeta>,String>` recursive, includes dirs, errors on unavailable roots and symlinks (never silently ignores unreadable content). Relative normalized `/` paths.
`Provider::copy(&self, from_root:&str, from_rel:&str, to_root:&str, to_rel:&str, overwrite:bool) -> Result<u64,String>` safe temp+rename where supported, preserves mtime, verifies copied bytes/content; rejects traversal/symlink/root overlap. `Provider::remove(&self,root:&str,rel:&str,is_dir:bool)->Result<(),String>` nonrecursive directory remove for local safety. `Provider::check_root(&self,root:&str)->Result<(),String>`. `Provider::test_connection(&self, connection:&Value)->Result<Value,String>` returns updated connection; no secrets.
`providers::capabilities()->Value`; `credentials::set(id:&str,secret:&str)->Result<(),String>`, `credentials::get(id:&str)->Result<Option<String>,String>`, `credentials::delete(id:&str)->Result<(),String>`. Core resolves credentials through provider, provider may expose rsync copy as `copy_rsync` with same args; declare actual availability.

## Safety / validation

Fixtures exclusively in temporary test roots. Never execute test plans on the user's real files. Tests cover mirror/update/two-way prior state/conflicts/custom/regex/selection, stale previews, disappearing roots, nested roots, symlinks, cancellation, partial failures, reports, restoration, retention and plan persistence. HTTP tests cover auth rejection, origin rejection, API parity. UI tests and rendered light/dark desktop/narrow checks cover all views and actionable dialogs. Cross-platform CI validates target OS builds; local results must not be represented as remote CI results. Real provider auth needs user accounts; capability and test feedback must be honest.
