import { useState } from 'react';
import { useStore } from '../App';
import { call, errorText } from '../api';
import { StatusDot, statusLabel } from '../components';
import { formatDuration, formatSize, formatWhen, plural } from '../format';

export function ActivityView() {
  const { state, activity, go, notify, refreshActivity } = useStore();
  const [canceling, setCanceling] = useState(false);
  const job = activity.active;
  const plans = new Map(state.plans.map((p) => [p.id, p.name]));
  const percent = job && job.total > 0 ? Math.min(100, Math.round((job.completed / job.total) * 100)) : 0;

  const cancel = async () => {
    setCanceling(true);
    try {
      await call('cancel_run');
      await refreshActivity();
    } catch (e) {
      notify(errorText(e), 'error');
    } finally {
      setCanceling(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="titles">
          <h1>Activity</h1>
          <div className="subtitle">Current work, recent runs and messages from Backurau.</div>
        </div>
      </div>

      <section className="panel" aria-label="Current run">
        <div className="panel-head">
          <div className="grow">
            <h2>{job ? `Running ${plans.get(job.plan_id) ?? 'plan'}` : 'Nothing running'}</h2>
            {job && (
              <div className="muted num">
                {job.completed} of {job.total} items · {formatSize(job.bytes)}
              </div>
            )}
          </div>
          {job && (
            <button type="button" className="btn" disabled={canceling} onClick={cancel}>
              Cancel run
            </button>
          )}
        </div>
        {job ? (
          <div style={{ padding: '0 18px 16px' }}>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Run progress">
              <div style={{ width: `${percent}%` }} />
            </div>
            <div className="muted truncate" style={{ marginTop: 8 }} title={job.current_path}>
              {job.current_path || 'Preparing…'}
            </div>
            {activity.queued.length > 0 && <div className="muted">{plural(activity.queued.length, 'plan')} waiting</div>}
          </div>
        ) : (
          <div className="empty">Compare a plan and run it, or enable a schedule in Plan options.</div>
        )}
      </section>

      <section className="panel" aria-label="Recent runs">
        <div className="panel-head">
          <h2 className="grow">Recent runs</h2>
        </div>
        {state.runs.length === 0 ? (
          <div className="empty">No runs yet.</div>
        ) : (
          <div className="grid-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Changes</th>
                  <th>Size</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {state.runs.slice(0, 25).map((run) => {
                  const changes = run.counts.copied + run.counts.updated + run.counts.deleted;
                  return (
                    <tr key={run.id} className="clickable" tabIndex={0} onClick={() => go('snapshots', { runId: run.id })} onKeyDown={(e) => e.key === 'Enter' && go('snapshots', { runId: run.id })}>
                      <td className="wrap">{run.plan_name}</td>
                      <td className="num">{formatWhen(run.started)}</td>
                      <td>
                        <span className="cell-flex">
                          <StatusDot status={run.status} />
                          {statusLabel(run.status)}
                        </span>
                      </td>
                      <td className="num">{changes}</td>
                      <td className="num">{formatSize(run.bytes)}</td>
                      <td className="num">{formatDuration(run.duration_ms)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-label="Messages">
        <div className="panel-head">
          <h2 className="grow">Messages</h2>
        </div>
        {activity.logs.length === 0 ? (
          <div className="empty">No messages yet.</div>
        ) : (
          <ul className="log-list" style={{ padding: '0 18px 14px' }}>
            {[...activity.logs].reverse().slice(0, 100).map((log, i) => (
              <li key={`${log.ts}-${i}`}>
                <span className="num muted">{formatWhen(log.ts)}</span>
                <span className={`dot ${log.level === 'error' ? 'red' : log.level === 'warning' ? 'amber' : 'grey'}`} aria-label={log.level} />
                <span>{log.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
