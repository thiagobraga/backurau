import { AlertTriangle, Download, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useStore } from '../App';
import { call, errorText } from '../api';
import { Dialog, PathField, Select, Toggle } from '../components';
import type { Method, Mode, Pair, Plan } from '../types';
import { METHODS, MODES, MODE_HELP } from './CompareView';

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

function ErrorNotice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="notice error" role="alert" style={{ marginTop: 12 }}>
      <AlertTriangle size={18} />
      <div className="grow">{text}</div>
    </div>
  );
}

const PATTERN_HINT = 'One pattern per line. Globs like *.tmp or node_modules/**, or regex:^cache/.';

// ---------- one folder pair ----------

export function PairDialog({ plan, pair, onClose }: { plan: Plan; pair: Pair | null; onClose: () => void }) {
  const { state, savePlan } = useStore();
  const [left, setLeft] = useState(pair?.left ?? '');
  const [right, setRight] = useState(pair?.right ?? '');
  const [custom, setCustom] = useState(Boolean(pair?.overrides && Object.values(pair.overrides).some((v) => v !== undefined && v !== null)));
  const [mode, setMode] = useState<Mode>(pair?.overrides?.mode ?? plan.mode);
  const [method, setMethod] = useState<Method>(pair?.overrides?.method ?? plan.method);
  const [include, setInclude] = useState((pair?.overrides?.include ?? []).join('\n'));
  const [exclude, setExclude] = useState((pair?.overrides?.exclude ?? []).join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const overrides = custom ? { mode, method, include: lines(include), exclude: lines(exclude) } : null;
    const next: Pair = { id: pair?.id ?? '', left: left.trim(), right: right.trim(), overrides };
    const pairs = pair ? plan.pairs.map((p) => (p.id === pair.id ? next : p)) : [...plan.pairs, next];
    setSaving(true);
    try {
      await savePlan({ ...plan, pairs });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={pair ? 'Edit folder pair' : 'Add folder pair'}
      subtitle={plan.name}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={saving || !left.trim() || !right.trim()} onClick={submit}>
            {pair ? 'Save pair' : 'Add pair'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>Source</label>
        <PathField label="Source folder" value={left} onChange={setLeft} connections={state.connections} />
        <label>Destination</label>
        <PathField label="Destination folder" value={right} onChange={setRight} connections={state.connections} />
        <label>Custom rules</label>
        <span className="check-row">
          <Toggle label="Use custom rules for this pair" checked={custom} onChange={setCustom} />
          <span className="muted">{custom ? 'This pair ignores the plan mode, method and patterns.' : 'Uses the plan settings.'}</span>
        </span>
        {custom && (
          <>
            <label>Mode</label>
            <Select label="Pair mode" value={mode} options={MODES} onChange={setMode} width="100%" />
            <span className="hint">{MODE_HELP[mode]}</span>
            <label>Method</label>
            <Select label="Pair method" value={method} options={METHODS} onChange={setMethod} width="100%" />
            <label htmlFor="pair-include">Include</label>
            <textarea id="pair-include" className="textarea" rows={3} value={include} onChange={(e) => setInclude(e.target.value)} spellCheck={false} />
            <label htmlFor="pair-exclude">Exclude</label>
            <textarea id="pair-exclude" className="textarea" rows={3} value={exclude} onChange={(e) => setExclude(e.target.value)} spellCheck={false} />
            <span className="hint">{PATTERN_HINT}</span>
          </>
        )}
      </div>
      <ErrorNotice text={error} />
    </Dialog>
  );
}

// ---------- plan options ----------

const CONFLICT_POLICIES = [
  ['ask', 'Ask me'],
  ['left', 'Keep source'],
  ['right', 'Keep destination'],
  ['both', 'Keep both'],
  ['skip', 'Skip'],
] as const;

const INTERVALS = [
  ['15', 'Every 15 minutes'],
  ['60', 'Every hour'],
  ['360', 'Every 6 hours'],
  ['1440', 'Every day'],
  ['10080', 'Every week'],
] as const;

const LEFT_ONLY = [['copy_right', 'Copy to destination'], ['skip', 'Skip']] as const;
const RIGHT_ONLY = [['copy_left', 'Copy to source'], ['delete_right', 'Delete from destination'], ['skip', 'Skip']] as const;
const DIFFERENT = [['copy_right', 'Source wins'], ['copy_left', 'Destination wins'], ['conflict', 'Ask'], ['skip', 'Skip']] as const;

export function PlanOptionsDialog({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const { state, savePlan, refresh, notify } = useStore();
  const [draft, setDraft] = useState<Plan>(plan);
  const [include, setInclude] = useState(plan.include.join('\n'));
  const [exclude, setExclude] = useState(plan.exclude.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Plan>(key: K, value: Plan[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = async () => {
    setSaving(true);
    try {
      await savePlan({ ...draft, include: lines(include), exclude: lines(exclude) });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  const exportPlan = async () => {
    try {
      const data = await call<Plan>('export_plan', { id: plan.id });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${plan.name.replace(/[^\w.-]+/g, '-')}.backurau-plan.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const importPlan = async (file: File) => {
    try {
      const imported = await call<Plan>('import_plan', { plan: JSON.parse(await file.text()) });
      await call('select_plan', { id: imported.id });
      await refresh();
      notify(`Imported plan "${imported.name}"`, 'success');
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const days = draft.schedule.interval_minutes;
  const intervals = INTERVALS.some(([v]) => Number(v) === days) ? INTERVALS : [...INTERVALS, [String(days), `Every ${days} minutes`] as const];

  return (
    <Dialog
      title="Plan options"
      subtitle={plan.name}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="left" style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn ghost" onClick={exportPlan}>
              <Download size={16} /> Export
            </button>
            <button type="button" className="btn ghost" onClick={() => importRef.current?.click()}>
              <Upload size={16} /> Import
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              hidden
              aria-label="Import plan file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importPlan(file);
                e.target.value = '';
              }}
            />
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={saving} onClick={submit}>
            Save options
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>Mode</label>
        <Select label="Plan mode" value={draft.mode} options={MODES} onChange={(v) => set('mode', v)} width="100%" />
        <span className="hint">{MODE_HELP[draft.mode]}</span>
        <label>Method</label>
        <Select label="Compare method" value={draft.method} options={METHODS} onChange={(v) => set('method', v)} width="100%" />
        {draft.mode === 'custom' && (
          <>
            <label>Only on source</label>
            <Select label="Action for files only on the source" value={draft.custom.left_only} options={LEFT_ONLY} onChange={(v) => set('custom', { ...draft.custom, left_only: v })} width="100%" />
            <label>Only on destination</label>
            <Select label="Action for files only on the destination" value={draft.custom.right_only} options={RIGHT_ONLY} onChange={(v) => set('custom', { ...draft.custom, right_only: v })} width="100%" />
            <label>Different</label>
            <Select label="Action for files that differ" value={draft.custom.different} options={DIFFERENT} onChange={(v) => set('custom', { ...draft.custom, different: v })} width="100%" />
          </>
        )}
        <label>Conflicts</label>
        <Select label="Conflict policy" value={draft.conflict_policy} options={CONFLICT_POLICIES} onChange={(v) => set('conflict_policy', v)} width="100%" />
        <label htmlFor="plan-include">Include</label>
        <textarea id="plan-include" className="textarea" rows={3} value={include} onChange={(e) => setInclude(e.target.value)} spellCheck={false} placeholder="Everything" />
        <label htmlFor="plan-exclude">Exclude</label>
        <textarea id="plan-exclude" className="textarea" rows={3} value={exclude} onChange={(e) => setExclude(e.target.value)} spellCheck={false} />
        <span className="hint">{PATTERN_HINT}</span>
        <label>Snapshots</label>
        <Select
          label="Snapshot mode"
          value={draft.snapshot_mode}
          options={[['versions', 'Keep replaced and deleted file versions'], ['reports', 'Reports only']] as const}
          onChange={(v) => set('snapshot_mode', v)}
          width="100%"
        />
        <label htmlFor="plan-retention">Keep last</label>
        <span className="check-row">
          <input
            id="plan-retention"
            className="input"
            type="number"
            min={1}
            max={1000}
            style={{ width: 96 }}
            value={draft.retention}
            onChange={(e) => set('retention', Math.max(1, Number(e.target.value) || 1))}
          />
          snapshots
        </span>
        <label>Engine</label>
        <Select
          label="Copy engine"
          value={draft.engine}
          options={[['native', 'Built in'], ['rsync', 'rsync (local folders)']] as const}
          onChange={(v) => set('engine', v)}
          width="100%"
          disabled={!state.capabilities.providers.rsync.available}
        />
        {!state.capabilities.providers.rsync.available && <span className="hint">rsync was not found on this computer.</span>}
        <label>Schedule</label>
        <span className="check-row">
          <Toggle label="Run automatically" checked={draft.schedule.enabled} onChange={(v) => set('schedule', { ...draft.schedule, enabled: v })} />
          <span className="muted">{draft.schedule.enabled ? 'Runs while Backurau or its service is running.' : 'Off'}</span>
        </span>
        {draft.schedule.enabled && (
          <>
            <label>Every</label>
            <Select
              label="Schedule interval"
              value={String(days)}
              options={intervals}
              onChange={(v) => set('schedule', { ...draft.schedule, interval_minutes: Number(v) })}
              width="100%"
            />
            <label>Triggers</label>
            <span className="check-row" style={{ flexWrap: 'wrap', gap: 16 }}>
              <label className="check-row">
                <Toggle label="Run when files change" checked={draft.schedule.on_change} onChange={(v) => set('schedule', { ...draft.schedule, on_change: v })} />
                When files change
              </label>
              <label className="check-row">
                <Toggle label="Run when destination becomes available" checked={draft.schedule.on_available} onChange={(v) => set('schedule', { ...draft.schedule, on_available: v })} />
                When destination appears
              </label>
            </span>
            <span className="hint">Automatic runs apply every default-selected change without review, including mirror deletions (replaced and deleted files are kept as saved versions). Conflicts are skipped and reported.</span>
          </>
        )}
      </div>
      <ErrorNotice text={error} />
    </Dialog>
  );
}
