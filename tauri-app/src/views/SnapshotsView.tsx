import { AlertTriangle, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../App';
import { call, errorText } from '../api';
import { Checkbox, Dialog, FileIcon, PathField, StatusDot, statusLabel } from '../components';
import { baseName, formatDuration, formatSize, formatStamp, formatWhen, parentPath, plural } from '../format';
import type { Run, Version } from '../types';

const STATE_TEXT: Record<Run['snapshot_state'], string> = {
  available: 'Saved versions available',
  reports_only: 'Report only. No file data was kept for this run.',
  pruned: 'Saved versions were removed by the retention setting.',
  unavailable: 'Saved versions are missing from disk.',
};

export function SnapshotsView({ runId, onSelectRun }: { runId: string | null; onSelectRun: (id: string | null) => void }) {
  const { state, plan, notify, refresh } = useStore();
  const runs = state.runs;
  const run = runs.find((r) => r.id === runId) ?? runs.find((r) => r.plan_id === plan?.id) ?? runs[0];
  const [detail, setDetail] = useState<Run | null>(null);
  const [dir, setDir] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [restoring, setRestoring] = useState<'selected' | 'all' | null>(null);

  useEffect(() => {
    setDir('');
    setQuery('');
    setPicked(new Set());
    setDetail(null);
    if (!run) return;
    let live = true;
    call<Run>('get_run', { id: run.id })
      .then((r) => live && setDetail(r))
      .catch((e) => notify(errorText(e), 'error'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id]);

  const versions = run?.versions ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return versions.filter((v) => v.path.toLowerCase().includes(q));
    // One level of the saved tree: files here plus the folders below.
    const prefix = dir ? `${dir}/` : '';
    const inside = versions.filter((v) => v.path.startsWith(prefix));
    const folders = new Map<string, number>();
    const files: Version[] = [];
    for (const v of inside) {
      const rest = v.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) files.push(v);
      else folders.set(rest.slice(0, slash), (folders.get(rest.slice(0, slash)) ?? 0) + 1);
    }
    return { folders: [...folders.entries()].sort(([a], [b]) => a.localeCompare(b)), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  }, [versions, dir, query]);

  if (!run) {
    return (
      <>
        <div className="page-head">
          <div className="titles">
            <h1>Snapshots</h1>
          </div>
        </div>
        <div className="panel">
          <div className="empty">No runs yet. Run a plan to create its first snapshot.</div>
        </div>
      </>
    );
  }

  const files = Array.isArray(shown) ? shown : shown.files;
  const folders = Array.isArray(shown) ? [] : shown.folders;
  const selectedBytes = versions.filter((v) => picked.has(v.id)).reduce((s, v) => s + v.size, 0);
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const crumbs = dir ? dir.split('/') : [];
  const plural_ = run.counts;

  return (
    <>
      <div className="page-head">
        <div className="titles">
          <h1>Snapshots</h1>
          <div className="subtitle">Saved versions keep files that a run replaced or deleted. They are not a point-in-time image of the folders.</div>
        </div>
      </div>

      <section className="panel" aria-label="Run history">
        <div className="panel-head">
          <h2 className="grow">Run history</h2>
        </div>
        <div className="grid-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Started</th>
                <th>Status</th>
                <th>Saved versions</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(0, 50).map((r) => (
                <tr key={r.id} className={`clickable${r.id === run.id ? ' selected' : ''}`} tabIndex={0} aria-selected={r.id === run.id} onClick={() => onSelectRun(r.id)} onKeyDown={(e) => e.key === 'Enter' && onSelectRun(r.id)}>
                  <td className="wrap">{r.plan_name}</td>
                  <td className="num">{formatWhen(r.started)}</td>
                  <td>
                    <span className="cell-flex">
                      <StatusDot status={r.status} />
                      {statusLabel(r.status)}
                    </span>
                  </td>
                  <td>{r.snapshot_state === 'available' ? plural(r.versions.length, 'file') : r.snapshot_state === 'reports_only' ? 'Report only' : r.snapshot_state === 'pruned' ? 'Removed' : 'Missing'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-label="Run report">
        <div className="panel-head">
          <div className="grow">
            <h2>{run.plan_name}</h2>
            <div className="muted">
              {formatStamp(run.started)} · {formatDuration(run.duration_ms)} · {formatSize(run.bytes)} · {run.trigger}
            </div>
          </div>
          <span className="cell-flex">
            <StatusDot status={run.status} />
            {statusLabel(run.status)}
          </span>
        </div>
        <div style={{ padding: '0 18px 16px' }}>
          <div className="kv">
            {(
              [
                ['Copied', plural_.copied],
                ['Updated', plural_.updated],
                ['Deleted', plural_.deleted],
                ['Skipped', plural_.skipped],
                ['Conflicts', plural_.conflicts],
                ['Failed', plural_.failed],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <div className="k">{k}</div>
                <div className="v">{v}</div>
              </div>
            ))}
          </div>
          {[...run.errors.map((t) => ['error', t]), ...run.warnings.map((t) => ['warn', t])].map(([kind, text], i) => (
            <div key={i} className={`notice ${kind}`} style={{ marginTop: 10 }}>
              <AlertTriangle size={18} />
              <div className="grow">{text}</div>
            </div>
          ))}
          {detail && detail.actions.some((a) => a.result === 'failed') && (
            <div className="notice error" style={{ marginTop: 10 }}>
              <AlertTriangle size={18} />
              <ul className="grow">
                {detail.actions.filter((a) => a.result === 'failed').slice(0, 20).map((a) => (
                  <li key={a.path}>
                    {a.path}: {a.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <section className="panel" aria-label="Saved versions">
        <div className="panel-head">
          <div className="grow">
            <h2>Saved versions</h2>
            <div className="muted">{STATE_TEXT[run.snapshot_state]}</div>
          </div>
          {run.snapshot_state === 'available' && (
            <>
              <button type="button" className="btn" disabled={picked.size === 0} onClick={() => setRestoring('selected')}>
                Restore selected{picked.size > 0 ? ` (${picked.size})` : ''}
              </button>
              <button type="button" className="btn" onClick={() => setRestoring('all')}>
                Restore snapshot
              </button>
            </>
          )}
        </div>
        {run.snapshot_state === 'available' && versions.length > 0 && (
          <>
            <div className="filters" style={{ padding: '0 18px 8px' }}>
              <span className="search">
                <Search size={16} />
                <input className="input" aria-label="Search saved versions" placeholder="Search files" value={query} onChange={(e) => setQuery(e.target.value)} />
              </span>
            </div>
            {!query && (
              <nav className="crumbs" aria-label="Folder">
                <button type="button" onClick={() => setDir('')}>
                  All saved files
                </button>
                {crumbs.map((c, i) => (
                  <span key={i}>
                    / <button type="button" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
                  </span>
                ))}
              </nav>
            )}
            <div className="grid-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th style={{ width: 40 }} />
                    <th>Name</th>
                    <th>Original location</th>
                    <th>Size</th>
                    <th>Saved</th>
                  </tr>
                </thead>
                <tbody>
                  {folders.map(([name, count]) => (
                    <tr key={name} className="clickable" tabIndex={0} onClick={() => setDir(dir ? `${dir}/${name}` : name)} onKeyDown={(e) => e.key === 'Enter' && setDir(dir ? `${dir}/${name}` : name)}>
                      <td />
                      <td>
                        <span className="cell-flex">
                          <FileIcon dir />
                          {name}
                        </span>
                      </td>
                      <td className="muted">{plural(count, 'file')}</td>
                      <td />
                      <td />
                    </tr>
                  ))}
                  {files.map((v) => (
                    <tr key={v.id} className={picked.has(v.id) ? 'selected' : undefined}>
                      <td>
                        <Checkbox label={`Select ${v.path}`} checked={picked.has(v.id)} onChange={() => toggle(v.id)} />
                      </td>
                      <td>
                        <span className="cell-flex">
                          <FileIcon name={baseName(v.path)} />
                          {baseName(v.path)}
                        </span>
                      </td>
                      <td className="wrap muted" title={v.original_location}>
                        {query ? v.path : parentPath(v.path) || '/'}
                      </td>
                      <td className="num">{formatSize(v.size)}</td>
                      <td className="num">{formatWhen(v.saved_at)}</td>
                    </tr>
                  ))}
                  {files.length + folders.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No matching files.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="panel-foot">
              <span className="muted">{picked.size > 0 ? `${plural(picked.size, 'file')} selected · ${formatSize(selectedBytes)}` : `${plural(versions.length, 'saved file')} in this snapshot`}</span>
            </div>
          </>
        )}
        {run.snapshot_state === 'available' && versions.length === 0 && <div className="empty">This run did not replace or delete any file.</div>}
      </section>

      {restoring && (
        <RestoreDialog
          run={run}
          ids={restoring === 'all' ? versions.map((v) => v.id) : [...picked]}
          onClose={() => setRestoring(null)}
          onDone={async () => {
            setRestoring(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}

function RestoreDialog({ run, ids, onClose, onDone }: { run: Run; ids: string[]; onClose: () => void; onDone: () => void }) {
  const { state, notify } = useStore();
  const [target, setTarget] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ restored: number; skipped: string[]; errors: string[] } | null>(null);

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ restored: number; skipped: string[]; errors: string[] }>('restore_versions', { run_id: run.id, version_ids: ids, target: target.trim(), overwrite });
      setResult(r);
      notify(`Restored ${plural(r.restored, 'file')}`, r.errors.length ? 'error' : 'success');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Restore saved versions"
      subtitle={`${plural(ids.length, 'file')} from ${run.plan_name}`}
      onClose={result ? onDone : onClose}
      footer={
        result ? (
          <button type="button" className="btn primary" onClick={onDone}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={busy || !target.trim()} onClick={restore}>
              Restore
            </button>
          </>
        )
      }
    >
      {result ? (
        <div>
          <p>
            Restored {plural(result.restored, 'file')}.
            {result.skipped.length > 0 && ` ${plural(result.skipped.length, 'file')} skipped because they already exist.`}
          </p>
          {result.errors.length > 0 && (
            <div className="notice error">
              <AlertTriangle size={18} />
              <ul className="grow">
                {result.errors.slice(0, 20).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="form-grid">
          <label>Restore into</label>
          <PathField label="Restore folder" value={target} onChange={setTarget} connections={[]} placeholder="/absolute/path/to/existing/folder" />
          <span className="hint">Files keep their relative paths inside this folder. Choose an empty folder to avoid mixing with current files.</span>
          <label>Existing files</label>
          <span className="check-row">
            <Checkbox label="Overwrite existing files" checked={overwrite} onChange={setOverwrite} />
            Overwrite files that already exist
          </span>
          {error && (
            <div className="notice error" role="alert">
              <AlertTriangle size={18} />
              <div className="grow">{error}</div>
            </div>
          )}
          <span className="hint">{state.connections.length > 0 ? 'Restore targets must be local folders.' : ''}</span>
        </div>
      )}
    </Dialog>
  );
}
