import {
  ArrowLeftRight,
  ChartColumnBig,
  Clock,
  Database,
  Folder,
  Link2,
  Minus,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Square,
  Sun,
  X,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AuthRequired, call, errorText, isDesktop, setToken, windowControl } from './api';
import birdUrl from './assets/bird.png';
import wordRedUrl from './assets/wordmark-red.png';
import wordWhiteUrl from './assets/wordmark-white.png';
import { Toast, ToastContext } from './components';
import { formatShort, formatWhen } from './format';
import type { Activity, AppState, Comparison, Plan, Run, Settings, SettingsTab, View } from './types';
import { ActivityView } from './views/ActivityView';
import { CompareView, NewPlanDialog } from './views/CompareView';
import { SettingsView } from './views/SettingsView';
import { SnapshotsView } from './views/SnapshotsView';

export interface Store {
  state: AppState;
  activity: Activity;
  plan: Plan | null;
  refresh: () => Promise<void>;
  refreshActivity: () => Promise<void>;
  comparisons: Record<string, Comparison>;
  setComparison: (planId: string, c: Comparison | null) => void;
  go: (view: View, opts?: { tab?: SettingsTab; runId?: string }) => void;
  selectPlan: (id: string) => Promise<void>;
  savePlan: (plan: Plan) => Promise<Plan>;
  notify: (text: string, kind?: Toast['kind']) => void;
  theme: 'light' | 'dark';
}

const StoreContext = createContext<Store | null>(null);
export const useStore = () => useContext(StoreContext)!;

const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

type Gate = { kind: 'loading' } | { kind: 'token'; error?: string } | { kind: 'offline'; error: string } | { kind: 'ready' };

export default function App() {
  const [gate, setGate] = useState<Gate>({ kind: 'loading' });
  const [state, setState] = useState<AppState | null>(null);
  const [activity, setActivity] = useState<Activity>({ active: null, queued: [], logs: [] });
  const [comparisons, setComparisons] = useState<Record<string, Comparison>>({});
  const [view, setView] = useState<View>('compare');
  const [tab, setTab] = useState<SettingsTab>('general');
  const [runId, setRunId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth <= 900);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [creating, setCreating] = useState(false);
  const [prefersDark, setPrefersDark] = useState(systemDark);

  const notify = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setState(await call<AppState>('get_state'));
      setGate({ kind: 'ready' });
    } catch (e) {
      if (e instanceof AuthRequired) setGate({ kind: 'token' });
      else if (!state) setGate({ kind: 'offline', error: errorText(e) });
      else notify(errorText(e), 'error');
    }
  }, [notify, state]);

  const refreshActivity = useCallback(async () => {
    try {
      setActivity(await call<Activity>('get_activity'));
    } catch {
      // Connection problems surface through refresh().
    }
  }, []);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll live job state: fast while a run is active, slow otherwise.
  const active = Boolean(activity.active);
  const wasActive = useRef(false);
  useEffect(() => {
    if (gate.kind !== 'ready') return;
    void refreshActivity();
    const timer = setInterval(refreshActivity, active ? 700 : 4000);
    return () => clearInterval(timer);
  }, [gate.kind, active, refreshActivity]);
  useEffect(() => {
    if (wasActive.current && !active) void refresh();
    wasActive.current = active;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // In-app notifications for automatic runs, per Settings > Notifications.
  const seenRuns = useRef<string | null>(null);
  useEffect(() => {
    const latest = state?.runs[0];
    if (!latest || latest.status === 'running') return;
    if (seenRuns.current === null || seenRuns.current === latest.id) {
      seenRuns.current = latest.id;
      return;
    }
    seenRuns.current = latest.id;
    const n = state.settings.notifications;
    if (!n.enabled || latest.trigger === 'manual') return;
    if (latest.status === 'completed' && n.on_success) notify(`${latest.plan_name}: automatic run completed`, 'success');
    if (latest.status === 'completed_with_conflicts' && n.on_conflict) notify(`${latest.plan_name}: ${latest.counts.conflicts} conflicts skipped`, 'error');
    if ((latest.status === 'failed' || latest.status === 'completed_with_warnings') && n.on_error) notify(`${latest.plan_name}: ${latest.errors[0] ?? 'run finished with warnings'}`, 'error');
  }, [state, notify]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => setPrefersDark(mq.matches);
    mq?.addEventListener?.('change', onChange);
    return () => mq?.removeEventListener?.('change', onChange);
  }, []);
  const setting = state?.settings.theme ?? 'system';
  const theme: 'light' | 'dark' = setting === 'system' ? (prefersDark ? 'dark' : 'light') : setting;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = state?.settings.density ?? 'comfortable';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#25231F' : '#F3EFE8');
  }, [theme, state?.settings.density]);

  const plan = useMemo(() => state?.plans.find((p) => p.id === state.last_plan_id) ?? null, [state]);

  const store: Store | null = state && {
    state,
    activity,
    plan,
    refresh,
    refreshActivity,
    comparisons,
    setComparison: (planId, c) =>
      setComparisons((all) => {
        const next = { ...all };
        if (c) next[planId] = c;
        else delete next[planId];
        return next;
      }),
    go: (v, opts) => {
      setView(v);
      if (opts?.tab) setTab(opts.tab);
      if (opts?.runId !== undefined) setRunId(opts.runId);
      if (window.innerWidth <= 900) setCollapsed(true);
    },
    selectPlan: async (id) => {
      if (id === state.last_plan_id) return;
      await call('select_plan', { id });
      setState({ ...state, last_plan_id: id });
    },
    savePlan: async (p) => {
      const saved = await call<Plan>('save_plan', { plan: p });
      setComparisons((all) => {
        const next = { ...all };
        delete next[saved.id];
        return next;
      });
      await refresh();
      return saved;
    },
    notify,
    theme,
  };

  const toggleTheme = async () => {
    if (!state) return;
    const settings: Settings = { ...state.settings, theme: theme === 'dark' ? 'light' : 'dark' };
    setState({ ...state, settings });
    try {
      await call('save_settings', { settings });
    } catch (e) {
      notify(errorText(e), 'error');
    }
  };

  return (
    <ToastContext.Provider value={notify}>
      <div className={`app${collapsed ? ' sidebar-collapsed' : ''}`}>
        <header className="titlebar" data-tauri-drag-region>
          <button type="button" className="icon-btn" aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
            <PanelLeft size={20} />
          </button>
          <div className="brand" data-tauri-drag-region>
            <img className="bird" src={birdUrl} alt="" data-tauri-drag-region />
            <img className="wordmark" src={theme === 'dark' ? wordWhiteUrl : wordRedUrl} alt="Backurau" data-tauri-drag-region />
          </div>
          <div className="spacer" data-tauri-drag-region />
          {state && (
            <button type="button" className="icon-btn" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title="Theme" onClick={toggleTheme}>
              {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
            </button>
          )}
          {isDesktop() && (
            <>
              <span className="sep" />
              <button type="button" className="icon-btn" aria-label="Minimize" onClick={() => windowControl('minimize')}>
                <Minus size={20} />
              </button>
              <button type="button" className="icon-btn" aria-label="Maximize" onClick={() => windowControl('maximize')}>
                <Square size={16} />
              </button>
              <button type="button" className="icon-btn close" aria-label="Close" onClick={() => windowControl('close')}>
                <X size={20} />
              </button>
            </>
          )}
        </header>
        {gate.kind !== 'ready' || !store ? (
          <GateScreen gate={gate} onRetry={refresh} />
        ) : (
          <StoreContext.Provider value={store}>
            <div className="body">
              <Sidebar view={view} tab={tab} runId={runId} onCreate={() => setCreating(true)} />
              <main className="main" id="main">
                {view === 'compare' && <CompareView />}
                {view === 'activity' && <ActivityView />}
                {view === 'snapshots' && <SnapshotsView runId={runId} onSelectRun={setRunId} />}
                {view === 'settings' && <SettingsView tab={tab} onTab={setTab} />}
              </main>
            </div>
            {creating && <NewPlanDialog onClose={() => setCreating(false)} />}
          </StoreContext.Provider>
        )}
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              <span className={`dot ${t.kind === 'error' ? 'red' : t.kind === 'success' ? 'green' : 'grey'}`} style={{ marginTop: 6 }} />
              <div className="grow">{t.text}</div>
              <button type="button" className="icon-btn small" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function GateScreen({ gate, onRetry }: { gate: Gate; onRetry: () => Promise<void> }) {
  const [token, setTokenValue] = useState('');
  if (gate.kind === 'loading') return <div className="gate muted">Connecting to Backurau…</div>;
  if (gate.kind === 'offline') {
    return (
      <div className="gate">
        <div className="card" role="alert">
          <h2>Backend not connected</h2>
          <p className="muted" style={{ margin: 0 }}>
            This page needs the Backurau desktop app or a running Backurau service. Nothing shown here is live until it connects.
          </p>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>{gate.error}</p>
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="gate">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(token.trim());
          void onRetry();
        }}
      >
        <h2>Connect to the Backurau service</h2>
        <p className="muted" style={{ margin: 0 }}>
          Enter the access token printed when the service started. It is also stored in <code>service-token</code> inside the service's data folder. The token is kept only for this browser tab.
        </p>
        <input className="input" type="password" autoComplete="off" aria-label="Access token" value={token} onChange={(e) => setTokenValue(e.target.value)} autoFocus />
        <button type="submit" className="btn primary" disabled={token.trim().length < 16}>
          Connect
        </button>
      </form>
    </div>
  );
}

function lastRunOf(runs: Run[], planId: string) {
  return runs.find((r) => r.plan_id === planId);
}

function Sidebar({ view, tab, runId, onCreate }: { view: View; tab: SettingsTab; runId: string | null; onCreate: () => void }) {
  const { state, plan, selectPlan, go, notify } = useStore();
  const planRuns = plan ? state.runs.filter((r) => r.plan_id === plan.id).slice(0, 3) : [];
  return (
    <nav className="sidebar" aria-label="Sidebar">
      <div className="group-label">
        Backup plans
        <button type="button" className="icon-btn small bordered" aria-label="New plan" title="New plan" onClick={onCreate}>
          <Plus size={18} />
        </button>
      </div>
      {state.plans.length === 0 && <div className="side-empty">No plans yet.</div>}
      {state.plans.map((p) => {
        const last = lastRunOf(state.runs, p.id);
        const selected = p.id === plan?.id;
        return (
          <div key={p.id}>
            <button
              type="button"
              className={`nav-item plan-item${selected ? ' active' : ''}`}
              aria-current={selected ? 'true' : undefined}
              onClick={() => {
                selectPlan(p.id).catch((e) => notify(errorText(e), 'error'));
                go('compare');
              }}
            >
              <Folder size={20} strokeWidth={1.6} />
              <span className="truncate">{p.name}</span>
              <span className="meta num">{last ? (selected && new Date(last.started * 1000).toDateString() === new Date().toDateString() ? `Last run ${formatShort(last.started)}` : formatShort(last.started)) : 'Never run'}</span>
            </button>
            {selected && planRuns.length > 0 && (
              <div className="nav-children run-tree">
                {planRuns.map((r) => (
                  <button key={r.id} type="button" className={`nav-child${view === 'snapshots' && runId === r.id ? ' active' : ''}`} onClick={() => go('snapshots', { runId: r.id })}>
                    <Clock size={16} />
                    <span className="num">{formatWhen(r.started)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="side-rule" />
      <div className="group-label">Navigation</div>
      <NavItem icon={<ArrowLeftRight size={20} strokeWidth={1.6} />} label="Compare" active={view === 'compare'} onClick={() => go('compare')} />
      <NavItem icon={<ChartColumnBig size={20} strokeWidth={1.6} />} label="Activity" active={view === 'activity'} onClick={() => go('activity')} />
      <NavItem icon={<Database size={20} strokeWidth={1.6} />} label="Snapshots" active={view === 'snapshots'} onClick={() => go('snapshots')} />
      <div className="side-rule" />
      <div className="group-label">Settings</div>
      <NavItem icon={<SettingsIcon size={20} strokeWidth={1.6} />} label="Settings" active={view === 'settings' && !['connections', 'general', 'service'].includes(tab)} onClick={() => go('settings', { tab: 'general' })} />
      <div className="nav-children">
        {(
          [
            ['connections', 'Connections', <Link2 size={16} key="c" />],
            ['general', 'General', <SlidersHorizontal size={16} key="g" />],
            ['service', 'Advanced', <MoreHorizontal size={16} key="a" />],
          ] as const
        ).map(([t, label, icon]) => (
          <button key={t} type="button" className={`nav-child${view === 'settings' && tab === t ? ' active' : ''}`} onClick={() => go('settings', { tab: t })}>
            {icon}
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`nav-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}
