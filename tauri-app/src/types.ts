// Mirrors the engine JSON contract in .specs/IMPLEMENTATION.md.
export type Mode = 'mirror' | 'update' | 'two_way' | 'custom';
export type Method = 'time_size' | 'content';
export type ConflictChoice = 'left' | 'right' | 'both' | 'skip';

export interface Overrides { mode?: Mode; method?: Method; include?: string[]; exclude?: string[] }
export interface Pair { id: string; left: string; right: string; overrides: Overrides | null }
export interface Plan {
  id: string;
  name: string;
  pairs: Pair[];
  mode: Mode;
  method: Method;
  include: string[];
  exclude: string[];
  conflict_policy: 'ask' | ConflictChoice;
  snapshot_mode: 'versions' | 'reports';
  retention: number;
  schedule: { enabled: boolean; interval_minutes: number; on_change: boolean; on_available: boolean };
  custom: { left_only: 'copy_right' | 'skip'; right_only: 'copy_left' | 'delete_right' | 'skip'; different: 'copy_right' | 'copy_left' | 'skip' | 'conflict' };
  engine: 'native' | 'rsync';
}

export interface FileMeta { size: number; modified: number; is_dir: boolean; hash: string | null }
export type RowStatus = 'added' | 'updated' | 'deleted' | 'unchanged' | 'conflict' | 'excluded';
export type Action = 'copy_right' | 'copy_left' | 'delete_right' | 'delete_left' | 'skip' | 'equal' | 'conflict' | 'both';
export interface Row {
  id: string;
  pair_id: string;
  path: string;
  left: FileMeta | null;
  right: FileMeta | null;
  status: RowStatus;
  action: Action;
  selected: boolean;
  reason: string | null;
}
export interface Totals { added: number; updated: number; deleted: number; unchanged: number; conflicts: number; bytes: number }
export interface Comparison { id: string; plan_id: string; created: number; rows: Row[]; totals: Totals; warnings: string[] }

export interface Counts { copied: number; updated: number; deleted: number; skipped: number; conflicts: number; failed: number }
export interface Version { id: string; path: string; original_location: string; size: number; saved_at: number; pair_id: string }
export type RunStatus = 'running' | 'completed' | 'completed_with_warnings' | 'completed_with_conflicts' | 'failed' | 'canceled' | 'interrupted';
export interface RunAction { path: string; pair_id: string; status: RowStatus; action: Action; result: 'done' | 'failed'; error: string | null }
export interface Run {
  id: string;
  plan_id: string;
  plan_name: string;
  started: number;
  finished: number | null;
  status: RunStatus;
  counts: Counts;
  bytes: number;
  duration_ms: number;
  errors: string[];
  warnings: string[];
  actions: RunAction[];
  versions: Version[];
  snapshot_state: 'available' | 'reports_only' | 'pruned' | 'unavailable';
  trigger: string;
}

export interface Job { id: string; plan_id: string; status: string; completed: number; total: number; bytes: number; current_path: string }
export interface Log { ts: number; level: 'info' | 'warning' | 'error'; message: string }
export interface Activity { active: Job | null; queued: string[]; logs: Log[] }

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  language: 'en';
  density: 'comfortable' | 'compact';
  start_minimized: boolean;
  run_in_background: boolean;
  default_plan_location: string;
  confirm_deletions: boolean;
  notifications: { enabled: boolean; on_success: boolean; on_error: boolean; on_conflict: boolean };
  security: { credential_store: 'os'; lock_on_exit: boolean };
  service: { enabled: boolean; bind: string; port: number };
}

export type ConnectionKind = 'local' | 'smb' | 'sftp' | 's3' | 'webdav' | 'gdrive' | 'onedrive' | 'rclone';
export type ConnectionStatus = 'not_tested' | 'available' | 'needs_authentication' | 'unavailable';
export interface Connection {
  id: string;
  name: string;
  kind: ConnectionKind;
  address: string;
  user: string;
  port: number | null;
  remote: string;
  status: ConnectionStatus;
  last_checked: number | null;
  message: string;
  options: { path?: string };
}

export interface Capabilities {
  providers: {
    rclone: { available: boolean };
    rsync: { available: boolean };
    credentials: { available: boolean; message: string };
  };
  automation: { requires_running_process: boolean };
  notifications: { desktop: boolean };
  data_dir: string;
}

export interface AppState {
  plans: Plan[];
  last_plan_id: string | null;
  settings: Settings;
  connections: Connection[];
  runs: Run[];
  capabilities: Capabilities;
}

export type View = 'compare' | 'activity' | 'snapshots' | 'settings';
export type SettingsTab = 'general' | 'connections' | 'notifications' | 'security' | 'service';
