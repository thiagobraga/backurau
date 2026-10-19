import { AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Checkbox, Dialog } from '../components';
import { formatSize, plural } from '../format';
import { effectiveAction, isDestructive } from '../logic';
import type { Action, ConflictChoice, Plan, Row } from '../types';

const ACTION_TEXT: Record<Action, string> = {
  copy_right: 'Copy to destination',
  copy_left: 'Copy to source',
  delete_right: 'Delete from destination',
  delete_left: 'Delete from source',
  both: 'Keep both',
  skip: 'Skip',
  equal: 'Unchanged',
  conflict: 'Unresolved conflict',
};

function rowSize(row: Row) {
  return (row.left ?? row.right)?.size ?? 0;
}

export function ReviewDialog({
  plan,
  rows,
  resolutions,
  onResolve,
  onClose,
  onConfirm,
}: {
  plan: Plan;
  rows: Row[];
  resolutions: Record<string, ConflictChoice>;
  onResolve: () => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const items = useMemo(() => rows.map((row) => ({ row, action: effectiveAction(row, resolutions) })), [rows, resolutions]);
  const unresolved = items.filter((i) => i.action === 'conflict').length;
  const deletes = items.filter((i) => i.action === 'delete_left' || i.action === 'delete_right').length;
  const overwrites = items.filter((i) => isDestructive(i.action, i.row) && !i.action.startsWith('delete')).length;
  const bytes = items.reduce((sum, i) => (i.action.startsWith('copy') || i.action === 'both' ? sum + rowSize(i.row) : sum), 0);
  const shown = showAll ? items : items.filter((i) => isDestructive(i.action, i.row) || i.action === 'conflict').slice(0, 200);

  return (
    <Dialog
      title="Review before running"
      subtitle={plan.name}
      wide
      onClose={onClose}
      footer={
        <>
          {unresolved > 0 && (
            <button type="button" className="btn left" onClick={onResolve}>
              Resolve conflicts
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={unresolved > 0} onClick={onConfirm}>
            Run {plural(items.length, 'change')}
          </button>
        </>
      }
    >
      <div className="kv">
        <div>
          <div className="k">Selected</div>
          <div className="v">{items.length}</div>
        </div>
        <div>
          <div className="k">To transfer</div>
          <div className="v">{formatSize(bytes)}</div>
        </div>
        <div>
          <div className="k">Overwrites</div>
          <div className="v">{overwrites}</div>
        </div>
        <div>
          <div className="k">Deletions</div>
          <div className="v">{deletes}</div>
        </div>
      </div>
      {unresolved > 0 && (
        <div className="notice warn" role="alert" style={{ marginTop: 12 }}>
          <AlertTriangle size={18} />
          <div className="grow">{plural(unresolved, 'conflict')} still unresolved. Resolve them or deselect those items before running.</div>
        </div>
      )}
      {overwrites + deletes > 0 && (
        <div className="notice" style={{ marginTop: 12 }}>
          <AlertTriangle size={18} />
          <div className="grow">Overwritten and deleted files are saved as retained versions and can be restored from Snapshots, subject to the retention setting.</div>
        </div>
      )}
      <div style={{ margin: '12px 0 6px' }}>
        <Checkbox label="Show every selected item" checked={showAll} onChange={setShowAll} />
        <span style={{ marginLeft: 8 }}>Show every selected item</span>
      </div>
      <div className="list-box">
        <table className="grid">
          <tbody>
            {shown.map(({ row, action }) => (
              <tr key={row.id}>
                <td className="wrap">{row.path}</td>
                <td>{ACTION_TEXT[action]}</td>
                <td className="num">{formatSize(rowSize(row))}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td>No overwrites or deletions. Everything selected adds new files.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}

const CHOICES: [ConflictChoice, string, string][] = [
  ['left', 'Keep source', 'Replace the destination with the source file'],
  ['right', 'Keep destination', 'Replace the source with the destination file'],
  ['both', 'Keep both', 'Copy each side across under a conflict name'],
  ['skip', 'Skip', 'Leave both files as they are'],
];

function sideText(row: Row, side: 'left' | 'right') {
  const meta = row[side];
  if (!meta) return 'Missing';
  return `${formatSize(meta.size)} · ${new Date(meta.modified * 1000).toLocaleString()}`;
}

export function ConflictDialog({
  plan,
  rows,
  allConflicts,
  resolutions,
  onClose,
  onApply,
}: {
  plan: Plan;
  rows: Row[];
  allConflicts: Row[];
  resolutions: Record<string, ConflictChoice>;
  onClose: () => void;
  onApply: (next: Record<string, ConflictChoice>, rule: ConflictChoice | null) => void;
}) {
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<Record<string, ConflictChoice>>(resolutions);
  const [all, setAll] = useState(false);
  const [remember, setRemember] = useState(false);
  const row = rows[index];
  const choice = draft[row.id];
  const targets = all ? allConflicts : [row];

  const pick = (c: ConflictChoice) => setDraft((d) => ({ ...d, ...Object.fromEntries(targets.map((r) => [r.id, c])) }));
  const last = index === rows.length - 1;
  const finish = () => onApply(draft, remember && choice ? choice : null);

  return (
    <Dialog
      title="Resolve conflict"
      subtitle={rows.length > 1 ? `${index + 1} of ${rows.length} · ${plan.name}` : plan.name}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {index > 0 && (
            <button type="button" className="btn" onClick={() => setIndex(index - 1)}>
              Previous
            </button>
          )}
          {!last ? (
            <button type="button" className="btn primary" onClick={() => setIndex(index + 1)}>
              Next
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={finish}>
              Apply
            </button>
          )}
        </>
      }
    >
      <p style={{ margin: '0 0 12px', wordBreak: 'break-all' }}>
        <strong>{row.path}</strong>
        <br />
        <span className="muted">{row.reason ?? 'Changed on both sides since the last run'}</span>
      </p>
      <div className="versus">
        <div>
          <div className="muted">Source</div>
          <div className="num">{sideText(row, 'left')}</div>
        </div>
        <div>
          <div className="muted">Destination</div>
          <div className="num">{sideText(row, 'right')}</div>
        </div>
      </div>
      <div className="choice-list" style={{ margin: '12px 0' }}>
        {CHOICES.map(([c, label, desc]) => (
          <button key={c} type="button" className="choice" aria-pressed={choice === c} onClick={() => pick(c)}>
            <strong>{label}</strong>
            <div className="desc">{desc}</div>
          </button>
        ))}
      </div>
      {allConflicts.length > 1 && (
        <label className="check-row">
          <Checkbox label="Apply to all conflicts in this comparison" checked={all} onChange={setAll} />
          Apply to all {allConflicts.length} conflicts in this comparison
        </label>
      )}
      <label className="check-row" style={{ marginTop: 8 }}>
        <Checkbox label="Save as plan rule" checked={remember} onChange={setRemember} />
        Remember this choice as the plan's conflict rule
      </label>
    </Dialog>
  );
}
