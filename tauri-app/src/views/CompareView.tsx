import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Database,
  Equal,
  Folder,
  List,
  LoaderCircle,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../App';
import { call, errorText } from '../api';
import { Checkbox, FileIcon, Menu, PathField, Select } from '../components';
import { formatSize, formatStamp, formatWhen, plural } from '../format';
import { actionable, buildTree, descendants, effectiveAction, hasChanges, isDestructive, TreeNode } from '../logic';
import type { Action, Comparison, ConflictChoice, Method, Mode, Pair, Plan, Row, RowStatus } from '../types';
import { PairDialog, PlanOptionsDialog } from './PlanDialogs';
import { ConflictDialog, ReviewDialog } from './RunDialogs';

export const MODES: readonly (readonly [Mode, string])[] = [
  ['mirror', 'Mirror →'],
  ['update', 'Update →'],
  ['two_way', 'Two-way ⇄'],
  ['custom', 'Custom'],
];
export const METHODS: readonly (readonly [Method, string])[] = [
  ['time_size', 'Time & size'],
  ['content', 'File content'],
];

const MAX_VISIBLE_ROWS = 1500;

export function CompareView() {
  const store = useStore();
  const { plan, state, comparisons, setComparison, notify, activity } = store;
  const [busy, setBusy] = useState<'compare' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [resolutions, setResolutions] = useState<Record<string, ConflictChoice>>({});
  const [dialog, setDialog] = useState<null | { kind: 'review' } | { kind: 'conflict'; rows: Row[] } | { kind: 'options' } | { kind: 'pair'; pair: Pair | null }>(null);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const comparison = plan ? comparisons[plan.id] : undefined;

  useEffect(() => {
    setResolutions({});
    setError(null);
  }, [comparison?.id, plan?.id]);

  if (!plan) return <EmptyWorkspace />;

  const save = async (next: Plan) => {
    try {
      await store.savePlan(next);
    } catch (e) {
      notify(errorText(e), 'error');
    }
  };

  const compare = async () => {
    setBusy('compare');
    setError(null);
    try {
      setComparison(plan.id, await call<Comparison>('compare_plan', { plan_id: plan.id }));
    } catch (e) {
      setComparison(plan.id, null);
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const selectedRows = comparison ? comparison.rows.filter((r) => r.selected && actionable(r.action)) : [];
  const runSelected = async (confirm: boolean) => {
    if (!comparison) return;
    setDialog(null);
    setBusy('run');
    setError(null);
    try {
      const run = await call<{ status: string; counts: { copied: number; updated: number; deleted: number; failed: number; conflicts: number } }>('run_plan', {
        comparison_id: comparison.id,
        selected: selectedRows.map((r) => r.id),
        resolutions,
        confirm_destructive: confirm,
      });
      const c = run.counts;
      notify(`${plan.name}: ${run.status.replace(/_/g, ' ')} · ${c.copied} copied, ${c.updated} updated, ${c.deleted} deleted${c.failed ? `, ${c.failed} failed` : ''}`, run.status === 'completed' ? 'success' : 'error');
      setComparison(plan.id, null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      await store.refresh();
    }
  };

  const onRun = () => {
    if (!comparison) return;
    const destructive = selectedRows.some((r) => isDestructive(effectiveAction(r, resolutions), r));
    const unresolved = selectedRows.some((r) => effectiveAction(r, resolutions) === 'conflict');
    if (destructive && !state.settings.confirm_deletions && !unresolved) void runSelected(true);
    else if (destructive || unresolved) setDialog({ kind: 'review' });
    else void runSelected(false);
  };

  const updateRows = (ids: Set<string>, selected: boolean) => {
    if (!comparison) return;
    setComparison(plan.id, { ...comparison, rows: comparison.rows.map((r) => (ids.has(r.id) && actionable(r.action) ? { ...r, selected } : r)) });
  };

  const lastRun = state.runs.find((r) => r.plan_id === plan.id);
  const lastChanges = lastRun ? lastRun.counts.copied + lastRun.counts.updated + lastRun.counts.deleted : 0;
  const running = activity.active?.plan_id === plan.id;
  const conflicts = comparison?.rows.filter((r) => r.status === 'conflict' && r.action === 'conflict') ?? [];

  return (
    <>
      <div className="page-head">
        <div className="titles">
          <div className="title-row">
            {renaming ? (
              <RenameInput
                value={plan.name}
                onDone={(name) => {
                  setRenaming(false);
                  if (name && name !== plan.name) void save({ ...plan, name });
                }}
              />
            ) : (
              <>
                <h1 className="truncate" title={plan.name}>
                  {plan.name}
                </h1>
                <button type="button" className="icon-btn small" aria-label="Rename plan" title="Rename" onClick={() => setRenaming(true)}>
                  <Pencil size={18} />
                </button>
              </>
            )}
          </div>
          <div className="status-line">
            {lastRun ? (
              <>
                <span className={`dot ${lastRun.status === 'completed' ? 'green' : lastRun.status === 'failed' || lastRun.status === 'interrupted' ? 'red' : 'amber'}`} />
                <span className="num">Last run {formatWhen(lastRun.started).replace(/^Today,/, 'today at').replace(/^Yesterday,/, 'yesterday at')}</span>
                <span className="mid-dot" />
                <span>{plural(lastChanges, 'change')}</span>
              </>
            ) : (
              <>
                <span className="dot grey" />
                <span>Never run</span>
              </>
            )}
            {comparison && (
              <>
                <span className="mid-dot" />
                <span className="num">Compared {formatWhen(comparison.created).split(', ')[1]}</span>
              </>
            )}
          </div>
        </div>
        <div className="head-actions">
          <button type="button" className="btn large" onClick={compare} disabled={busy !== null || running}>
            {busy === 'compare' ? <LoaderCircle size={20} className="spin" /> : <Search size={20} />}
            Compare
          </button>
          <button type="button" className="btn primary large" onClick={onRun} disabled={busy !== null || running || !comparison || selectedRows.length === 0} title={!comparison ? 'Compare first to preview changes' : undefined}>
            {busy === 'run' ? <LoaderCircle size={20} className="spin" /> : <RefreshCw size={20} />}
            Run
          </button>
        </div>
      </div>

      <div className="controls-row">
        <span className="field">
          <span className="lbl muted">Mode</span>
          <Select label="Mode" value={plan.mode} options={MODES} onChange={(mode) => save({ ...plan, mode })} icon={<Folder size={18} />} width={190} />
        </span>
        <span className="field">
          <span className="lbl muted">Method</span>
          <Select label="Method" value={plan.method} options={METHODS} onChange={(method) => save({ ...plan, method })} icon={<Database size={18} />} width={220} />
        </span>
        <button type="button" className="btn" onClick={() => setDialog({ kind: 'options' })}>
          <SlidersHorizontal size={18} />
          Options
        </button>
        <Totals comparison={comparison} />
      </div>

      {error && (
        <div className="notice error" role="alert">
          <AlertTriangle size={18} />
          <div className="grow">{error}</div>
        </div>
      )}
      {comparison && comparison.warnings.length > 0 && <Warnings warnings={comparison.warnings} />}
      {conflicts.length > 0 && (
        <div className="notice warn">
          <AlertTriangle size={18} />
          <div className="grow">
            {plural(conflicts.length, 'conflict')} need a decision. Unresolved conflicts are skipped when you run.
          </div>
          <button type="button" className="btn" onClick={() => setDialog({ kind: 'conflict', rows: conflicts })}>
            Resolve…
          </button>
        </div>
      )}
      {comparison && (
        <label className="check-row muted" style={{ fontSize: 13 }}>
          <Checkbox checked={onlyChanges} onChange={setOnlyChanges} label="Show only changes" />
          Show only changes
        </label>
      )}

      {plan.pairs.map((pair) => (
        <PairSection
          key={pair.id}
          plan={plan}
          pair={pair}
          comparison={comparison}
          resolutions={resolutions}
          onlyChanges={onlyChanges}
          onToggle={updateRows}
          onConflict={(row) => setDialog({ kind: 'conflict', rows: [row] })}
          onEdit={() => setDialog({ kind: 'pair', pair })}
          onSwap={() => save({ ...plan, pairs: plan.pairs.map((p) => (p.id === pair.id ? { ...p, left: p.right, right: p.left } : p)) })}
          onRemove={plan.pairs.length > 1 ? () => save({ ...plan, pairs: plan.pairs.filter((p) => p.id !== pair.id) }) : undefined}
        />
      ))}
      <button type="button" className="add-pair" onClick={() => setDialog({ kind: 'pair', pair: null })}>
        <Plus size={20} />
        Add folder pair
      </button>

      <ActivityStrip />

      {dialog?.kind === 'review' && comparison && (
        <ReviewDialog
          plan={plan}
          rows={selectedRows}
          resolutions={resolutions}
          onResolve={() => setDialog({ kind: 'conflict', rows: conflicts })}
          onClose={() => setDialog(null)}
          onConfirm={() => runSelected(true)}
        />
      )}
      {dialog?.kind === 'conflict' && (
        <ConflictDialog
          plan={plan}
          rows={dialog.rows}
          allConflicts={conflicts}
          resolutions={resolutions}
          onClose={() => setDialog(null)}
          onApply={(next, rule) => {
            setResolutions(next);
            setDialog(null);
            if (rule) void save({ ...plan, conflict_policy: rule });
          }}
        />
      )}
      {dialog?.kind === 'options' && <PlanOptionsDialog plan={plan} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'pair' && <PairDialog plan={plan} pair={dialog.pair} onClose={() => setDialog(null)} />}
    </>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <input
      className="title-input"
      aria-label="Plan name"
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onDone(text.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(text.trim());
        if (e.key === 'Escape') onDone(value);
      }}
    />
  );
}

function Totals({ comparison }: { comparison?: Comparison }) {
  if (!comparison) return <div className="totals muted">Not compared yet</div>;
  const t = comparison.totals;
  return (
    <div className="totals num" aria-label="Comparison totals">
      <span className="total">
        <span className="dot green" />+{t.added} new
      </span>
      <span className="total">
        <span className="dot amber" />
        {t.updated} updated
      </span>
      <span className="total">
        <span className="dot red" />−{t.deleted} deleted
      </span>
      <span className="total">
        <span className="dot grey" />
        {t.unchanged} unchanged
      </span>
      {t.conflicts > 0 && (
        <span className="total" style={{ color: 'var(--deleted-fg)' }}>
          <AlertTriangle size={14} />
          {plural(t.conflicts, 'conflict')}
        </span>
      )}
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="notice">
      <AlertTriangle size={18} />
      <div className="grow">
        {plural(warnings.length, 'note')} from this comparison.{' '}
        <button type="button" className="btn link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </button>
        {open && (
          <ul>
            {warnings.slice(0, 50).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
            {warnings.length > 50 && <li>…and {warnings.length - 50} more</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyWorkspace() {
  return (
    <>
      <div className="page-head">
        <div className="titles">
          <h1>No backup plan yet</h1>
          <div className="subtitle">Choose a source and a destination to compare. Nothing is copied until you review and run.</div>
        </div>
      </div>
      <NewPlanForm />
    </>
  );
}

/** Creation wizard: a name and a valid first folder pair, then the plan opens in Compare. */
export function NewPlanForm({ onDone }: { onDone?: () => void }) {
  const { state, savePlan, selectPlan, notify, go } = useStore();
  const [name, setName] = useState('');
  const [left, setLeft] = useState(state.settings.default_plan_location);
  const [right, setRight] = useState('');
  const [mode, setMode] = useState<Mode>('mirror');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const plan = await savePlan({
        id: '',
        name: name.trim() || left.split('/').filter(Boolean).pop() || 'New plan',
        pairs: [{ id: '', left: left.trim(), right: right.trim(), overrides: null }],
        mode,
      } as Plan);
      await selectPlan(plan.id);
      notify(`Created ${plan.name}. Compare to preview changes.`, 'success');
      go('compare');
      onDone?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="dialog-body" style={{ paddingTop: 16 }}>
        <div className="form-grid">
          <label htmlFor="np-name">Plan name</label>
          <input id="np-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Documents" />
          <label>Source</label>
          <PathField label="Source folder" value={left} onChange={setLeft} connections={state.connections} />
          <label>Destination</label>
          <PathField label="Destination folder" value={right} onChange={setRight} connections={state.connections} placeholder="/media/backup/Documents" />
          <span className="hint">The destination must already exist. An unreachable destination is reported as an error, never treated as empty.</span>
          <label>Mode</label>
          <Select label="Mode" value={mode} options={MODES} onChange={setMode} width="100%" />
          <span className="hint">{MODE_HELP[mode]}</span>
        </div>
        {error && (
          <div className="notice error" role="alert">
            <AlertTriangle size={18} />
            <div className="grow">{error}</div>
          </div>
        )}
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={saving || !left.trim() || !right.trim()}>
            Create plan
          </button>
        </div>
      </div>
    </form>
  );
}

export const MODE_HELP: Record<Mode, string> = {
  mirror: 'Make the destination match the source. Overwrites and deletes destination files; deleted files are kept as saved versions.',
  update: 'Copy new and newer files to the destination. Never deletes anything.',
  two_way: 'Propagate changes in both directions using the previous run. Edits on both sides become conflicts.',
  custom: 'Choose the action for each kind of difference in Options.',
};

export function NewPlanDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="New backup plan">
        <div className="dialog-head">
          <div className="grow">
            <h2>New backup plan</h2>
            <div className="subtitle">Start with one folder pair. You can add more pairs and rules later.</div>
          </div>
          <button type="button" className="icon-btn small" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div style={{ padding: '0 16px 16px' }}>
          <NewPlanForm onDone={onClose} />
        </div>
      </div>
    </div>
  );
}

// ---------- folder pair ----------

function PairSection(props: {
  plan: Plan;
  pair: Pair;
  comparison?: Comparison;
  resolutions: Record<string, ConflictChoice>;
  onlyChanges: boolean;
  onToggle: (ids: Set<string>, selected: boolean) => void;
  onConflict: (row: Row) => void;
  onEdit: () => void;
  onSwap: () => void;
  onRemove?: () => void;
}) {
  const { pair, comparison, resolutions, onlyChanges, onToggle } = props;
  const [open, setOpen] = useState(true);
  const [descending, setDescending] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rows = useMemo(() => comparison?.rows.filter((r) => r.pair_id === pair.id) ?? [], [comparison, pair.id]);
  const tree = useMemo(() => buildTree(rows, descending), [rows, descending]);
  useEffect(() => setExpanded({}), [comparison?.id]);

  const visible: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (visible.length > MAX_VISIBLE_ROWS) return;
      if (onlyChanges && !hasChanges(node)) continue;
      visible.push(node);
      const isOpen = expanded[node.row.path] ?? hasChanges(node);
      if (node.isDir && isOpen) walk(node.children);
    }
  };
  walk(tree);

  const selectable = rows.filter((r) => actionable(r.action));
  const selectedCount = selectable.filter((r) => r.selected).length;
  const overridden = Boolean(pair.overrides && Object.values(pair.overrides).some((v) => v !== undefined && v !== null));

  return (
    <section className={`pair${open ? ' open' : ''}`} aria-label={`${pair.left} to ${pair.right}`}>
      <div className="pair-head">
        <div className="paths">
          <span className="truncate" title={pair.left}>
            {pair.left}
          </span>
          <ArrowLeftRight size={18} aria-label="paired with" />
          <span className="truncate" title={pair.right}>
            {pair.right}
          </span>
        </div>
        <Menu
          label={overridden ? 'Pair options (custom settings)' : 'Pair options'}
          badge={overridden}
          items={[
            ['Edit folders and rules…', props.onEdit],
            ['Swap source and destination', props.onSwap],
            ...(props.onRemove ? ([['Remove pair', props.onRemove, undefined, true]] as [string, () => void, undefined, boolean][]) : []),
          ]}
        />
        <span className="vsep" />
        <button type="button" className="icon-btn small" aria-label={open ? 'Collapse pair' : 'Expand pair'} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
      </div>
      {open && (
        <div className="table-scroll">
          <div className="ctable" role="table" aria-label="Comparison">
            <div className="crow head" role="row">
              <div className="side" role="columnheader">
                <button type="button" className="sort-btn" onClick={() => setDescending(!descending)} aria-label={`Sort by name ${descending ? 'ascending' : 'descending'}`}>
                  Name {descending ? <ArrowDown size={14} /> : <ArrowUp size={14} />}
                </button>
                <span>Size</span>
                <span>Modified</span>
              </div>
              <div className="center" role="columnheader">
                <Checkbox
                  label="Select all changes in this pair"
                  checked={selectable.length > 0 && selectedCount === selectable.length}
                  mixed={selectedCount > 0 && selectedCount < selectable.length}
                  disabled={selectable.length === 0}
                  onChange={(v) => onToggle(new Set(selectable.map((r) => r.id)), v)}
                />
              </div>
              <div className="center action" role="columnheader">
                Action
              </div>
              <div className="side right" role="columnheader">
                <span>Name {descending ? <ArrowDown size={14} style={{ verticalAlign: -2 }} /> : <ArrowUp size={14} style={{ verticalAlign: -2 }} />}</span>
                <span>Size</span>
                <span>Modified</span>
              </div>
            </div>
            {!comparison && <div className="pair-empty">Compare to see how these folders differ.</div>}
            {comparison && rows.length === 0 && <div className="pair-empty">Both folders are empty.</div>}
            {comparison && rows.length > 0 && visible.length === 0 && <div className="pair-empty">No changes in this pair.</div>}
            {visible.slice(0, MAX_VISIBLE_ROWS).map((node) => (
              <CompareRow
                key={node.row.id}
                node={node}
                action={effectiveAction(node.row, resolutions)}
                resolved={Boolean(resolutions[node.row.id])}
                open={expanded[node.row.path] ?? hasChanges(node)}
                onOpen={(v) => setExpanded({ ...expanded, [node.row.path]: v })}
                onToggle={onToggle}
                onConflict={props.onConflict}
              />
            ))}
            {visible.length > MAX_VISIBLE_ROWS && <div className="more-rows">Showing the first {MAX_VISIBLE_ROWS} rows. Collapse folders or show only changes to see the rest.</div>}
          </div>
        </div>
      )}
    </section>
  );
}

function CompareRow({
  node,
  action,
  resolved,
  open,
  onOpen,
  onToggle,
  onConflict,
}: {
  node: TreeNode;
  action: Action;
  resolved: boolean;
  open: boolean;
  onOpen: (v: boolean) => void;
  onToggle: (ids: Set<string>, selected: boolean) => void;
  onConflict: (row: Row) => void;
}) {
  const { row, isDir } = node;
  const group = isDir ? [row, ...descendants(node)].filter((r) => actionable(r.action)) : actionable(row.action) ? [row] : [];
  const on = group.filter((r) => r.selected).length;
  const inactive = group.length === 0;
  const status: RowStatus = row.status;
  return (
    <div className={`crow st-${status}${on > 0 || inactive ? '' : ' unselected'}`} role="row" title={row.reason ?? undefined}>
      <Side meta={row.left} node={node} open={open} onOpen={onOpen} />
      <div className="center" role="cell">
        <Checkbox
          label={`Include ${row.path}`}
          checked={inactive ? status === 'unchanged' : on === group.length}
          mixed={!inactive && on > 0 && on < group.length}
          disabled={inactive}
          onChange={(v) => onToggle(new Set(group.map((r) => r.id)), v)}
        />
      </div>
      <div className="center action" role="cell">
        <ActionSymbol action={action} status={status} isDir={isDir} reason={row.reason} resolved={resolved} onConflict={() => onConflict(row)} />
      </div>
      <Side meta={row.right} node={node} right open={open} onOpen={onOpen} />
    </div>
  );
}

function Side({ meta, node, right, open, onOpen }: { meta: Row['left']; node: TreeNode; right?: boolean; open: boolean; onOpen: (v: boolean) => void }) {
  const indent = { paddingLeft: node.depth * 22 };
  if (!meta) {
    return (
      <div className={`side${right ? ' right' : ''}`} role="cell">
        <span className="cell-name" style={indent}>
          {!node.isDir && <FileIcon name={node.name} missing />}
          <span className="dash">—</span>
        </span>
        <span className="dash">—</span>
        <span className="dash">—</span>
      </div>
    );
  }
  const label = (
    <>
      {node.isDir && (node.children.length > 0 ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span style={{ width: 14 }} />)}
      <FileIcon name={node.name} dir={meta.is_dir} />
      <span className="truncate" title={node.row.path}>
        {node.name}
      </span>
    </>
  );
  return (
    <div className={`side${right ? ' right' : ''}`} role="cell">
      <span className="cell-name" style={indent}>
        {node.isDir && node.children.length > 0 ? (
          <button type="button" className="disclose" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${node.row.path}`} onClick={() => onOpen(!open)}>
            {label}
          </button>
        ) : (
          label
        )}
      </span>
      <span className="cell-meta">{meta.is_dir ? '—' : formatSize(meta.size)}</span>
      <span className="cell-meta">{formatStamp(meta.modified)}</span>
    </div>
  );
}

function ActionSymbol({ action, status, isDir, reason, resolved, onConflict }: { action: Action; status: RowStatus; isDir: boolean; reason: string | null; resolved: boolean; onConflict: () => void }) {
  const tone = status === 'conflict' ? (resolved ? 'updated' : 'conflict') : status;
  let icon;
  let label: string;
  switch (action) {
    case 'copy_right':
      icon = status === 'added' ? <Plus size={20} /> : <ArrowRight size={20} />;
      label = status === 'added' ? 'Create on destination' : 'Copy to destination';
      break;
    case 'copy_left':
      icon = <ArrowLeft size={20} />;
      label = status === 'added' ? 'Create on source' : 'Copy to source';
      break;
    case 'delete_right':
    case 'delete_left':
      icon = <Trash2 size={18} />;
      label = action === 'delete_right' ? 'Delete from destination' : 'Delete from source';
      break;
    case 'both':
      icon = <Copy size={18} />;
      label = 'Keep both';
      break;
    case 'conflict':
      icon = <AlertTriangle size={18} />;
      label = 'Conflict: choose what to keep';
      break;
    case 'equal':
      icon = isDir ? <Minus size={18} /> : <Equal size={18} />;
      label = 'In sync';
      break;
    default:
      icon = <Minus size={18} />;
      label = reason ?? 'Skipped';
  }
  if (status === 'conflict') {
    return (
      <button type="button" className={`act ${tone}`} aria-label={`${label}. Resolve conflict`} title={reason ?? label} onClick={onConflict}>
        {icon}
      </button>
    );
  }
  return (
    <span className={`act ${tone}`} role="img" aria-label={label} title={reason ? `${label}: ${reason}` : label}>
      {icon}
    </span>
  );
}

// ---------- activity strip ----------

function ActivityStrip() {
  const { activity, state, plan, go, notify } = useStore();
  const [open, setOpen] = useState(false);
  const job = activity.active;
  const lastRun = plan ? state.runs.find((r) => r.plan_id === plan.id) : undefined;
  const changes = lastRun ? lastRun.counts.copied + lastRun.counts.updated + lastRun.counts.deleted : 0;
  const pct = job && job.total ? Math.round((job.completed / job.total) * 100) : 0;
  return (
    <section className="strip" aria-label="Activity">
      <div className="strip-head">
        <List size={20} />
        <span>
          <span className="title">Activity</span>{' '}
          <span className="muted">{job ? `(running ${job.completed} of ${job.total})` : lastRun ? `(${plural(changes, 'change')} in the last run)` : '(no runs yet)'}</span>
        </span>
        <span style={{ flex: 1 }} />
        <span className="vsep" />
        <button type="button" className="icon-btn small" aria-label={open ? 'Collapse activity' : 'Expand activity'} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
      </div>
      {open && (
        <div className="strip-body">
          {job && (
            <>
              <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="field" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <span className="truncate muted">{job.current_path || 'Preparing…'}</span>
                <span className="num muted">
                  {pct}% · {formatSize(job.bytes)}
                </span>
                <button type="button" className="btn" onClick={() => call('cancel_run').then(() => notify('Cancel requested. The current file finishes first.'))}>
                  Cancel run
                </button>
              </div>
            </>
          )}
          <ul className="log-list">
            {activity.logs.slice(-6).reverse().map((l, i) => (
              <li key={i}>
                <span className="num muted">{formatWhen(l.ts).split(', ').pop()}</span>
                <span className={`dot ${l.level === 'error' ? 'red' : l.level === 'warning' ? 'amber' : 'grey'}`} />
                <span className="truncate">{l.message}</span>
              </li>
            ))}
            {activity.logs.length === 0 && <li className="muted">No activity in this session.</li>}
          </ul>
          <button type="button" className="btn link" style={{ alignSelf: 'flex-start' }} onClick={() => go('activity')}>
            Open Activity
          </button>
        </div>
      )}
    </section>
  );
}
