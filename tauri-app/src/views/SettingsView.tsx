import { AlertTriangle, Plus } from 'lucide-react';
import { ReactNode, useState } from 'react';
import { useStore } from '../App';
import { call, errorText, isDesktop } from '../api';
import { Dialog, Menu, Select, Toggle } from '../components';
import { formatWhen } from '../format';
import type { Connection, ConnectionKind, ConnectionStatus, Settings, SettingsTab } from '../types';

const TABS: [SettingsTab, string][] = [
  ['general', 'General'],
  ['connections', 'Connections'],
  ['notifications', 'Notifications'],
  ['security', 'Security'],
  ['service', 'Service & web'],
];

export function SettingsView({ tab, onTab }: { tab: SettingsTab; onTab: (t: SettingsTab) => void }) {
  const { state, refresh, notify } = useStore();
  const [draft, setDraft] = useState<Settings>(state.settings);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      await call('save_settings', { settings: draft });
      await refresh();
      notify('Settings saved', 'success');
    } catch (e) {
      notify(errorText(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="titles">
          <h1>Settings</h1>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <div role="tabpanel" aria-label="General">
          <Row label="Theme" desc="Follows the system unless you choose one.">
            <Select
              label="Theme"
              value={draft.theme}
              options={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const}
              onChange={(v) => set('theme', v)}
              width="100%"
            />
          </Row>
          <Row label="Density" desc="Row height in tables.">
            <Select label="Density" value={draft.density} options={[['comfortable', 'Comfortable'], ['compact', 'Compact']] as const} onChange={(v) => set('density', v)} width="100%" />
          </Row>
          <Row label="Language">
            <Select label="Language" value={draft.language} options={[['en', 'English']] as const} onChange={() => {}} width="100%" />
          </Row>
          <Row label="Start minimized" desc="Open in the background when the app starts.">
            <Toggle label="Start minimized" checked={draft.start_minimized} onChange={(v) => set('start_minimized', v)} />
          </Row>
          <Row label="Run in background" desc="Keep scheduled plans running after the window is closed.">
            <Toggle label="Run in background" checked={draft.run_in_background} onChange={(v) => set('run_in_background', v)} />
          </Row>
          <Row label="Default plan location" desc="Folder suggested when you create a plan.">
            <input className="input" aria-label="Default plan location" value={draft.default_plan_location} onChange={(e) => set('default_plan_location', e.target.value)} spellCheck={false} />
          </Row>
          <Row label="Confirm deletions" desc="Ask for review before a run that deletes or overwrites files.">
            <Toggle label="Confirm deletions" checked={draft.confirm_deletions} onChange={(v) => set('confirm_deletions', v)} />
          </Row>
        </div>
      )}

      {tab === 'connections' && <Connections />}

      {tab === 'notifications' && (
        <div role="tabpanel" aria-label="Notifications">
          <Row label="Notifications" desc="Show a message when an automatic run finishes while the app is open.">
            <Toggle label="Enable notifications" checked={draft.notifications.enabled} onChange={(v) => set('notifications', { ...draft.notifications, enabled: v })} />
          </Row>
          {(
            [
              ['on_success', 'Run completed'],
              ['on_error', 'Run failed or finished with warnings'],
              ['on_conflict', 'Conflicts were skipped'],
            ] as const
          ).map(([key, label]) => (
            <Row key={key} label={label}>
              <Toggle label={label} checked={draft.notifications[key]} disabled={!draft.notifications.enabled} onChange={(v) => set('notifications', { ...draft.notifications, [key]: v })} />
            </Row>
          ))}
          <p className="muted" style={{ padding: '12px 16px' }}>
            Messages appear inside Backurau. System notifications are {state.capabilities.notifications.desktop ? 'available' : 'not available in this build'}.
          </p>
        </div>
      )}

      {tab === 'security' && (
        <div role="tabpanel" aria-label="Security">
          <Row label="Credential storage" desc={state.capabilities.providers.credentials.message || 'Connection secrets are kept in the operating system credential store, never in Backurau files, logs or exports.'}>
            <span className="cell-flex">
              <span className={`dot ${state.capabilities.providers.credentials.available ? 'green' : 'red'}`} />
              {state.capabilities.providers.credentials.available ? 'Operating system store' : 'Unavailable'}
            </span>
          </Row>
          <Row label="Lock on exit" desc="Forget the web access token when the app closes.">
            <Toggle label="Lock on exit" checked={draft.security.lock_on_exit} onChange={(v) => set('security', { ...draft.security, lock_on_exit: v })} />
          </Row>
          <Row label="Data folder" desc="Plans, run history and saved versions live here.">
            <code className="truncate" title={state.capabilities.data_dir}>{state.capabilities.data_dir}</code>
          </Row>
        </div>
      )}

      {tab === 'service' && (
        <div role="tabpanel" aria-label="Service and web">
          <Row label="Web service" desc="The service is started separately (backurau-server) and needs its access token. These values describe how it is configured and are applied on its next start.">
            <Toggle label="Enable web service" checked={draft.service.enabled} onChange={(v) => set('service', { ...draft.service, enabled: v })} />
          </Row>
          <Row label="Address" desc="Keep this on loopback unless you add your own TLS proxy.">
            <input className="input" aria-label="Service address" value={draft.service.bind} onChange={(e) => set('service', { ...draft.service, bind: e.target.value })} spellCheck={false} />
          </Row>
          <Row label="Port">
            <input
              className="input"
              type="number"
              min={1}
              max={65535}
              aria-label="Service port"
              value={draft.service.port}
              onChange={(e) => set('service', { ...draft.service, port: Number(e.target.value) || 0 })}
            />
          </Row>
          <Row label="Schedules" desc="Plans with a schedule run only while the desktop app or the service is running.">
            <span className="muted">{state.capabilities.automation.requires_running_process ? 'Needs a running process' : 'Runs in the background'}</span>
          </Row>
          <Row label="Copy tools" desc="rclone handles cloud, SFTP and WebDAV connections; rsync copies between local folders.">
            <span className="muted">
              rclone {state.capabilities.providers.rclone.available ? 'found' : 'not found'} · rsync {state.capabilities.providers.rsync.available ? 'found' : 'not found'}
            </span>
          </Row>
        </div>
      )}

      {tab !== 'connections' && (
        <div className="form-actions" style={{ marginTop: 'auto', paddingTop: 16 }}>
          <button type="button" className="btn" disabled={!dirty || saving} onClick={() => setDraft(state.settings)}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!dirty || saving} onClick={save}>
            Save changes
          </button>
        </div>
      )}
    </>
  );
}

function Row({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="label">
        <div>{label}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

// ---------- connections ----------

const KINDS: [ConnectionKind, string][] = [
  ['sftp', 'SFTP'],
  ['webdav', 'WebDAV'],
  ['s3', 'S3 compatible'],
  ['smb', 'SMB'],
  ['gdrive', 'Google Drive'],
  ['onedrive', 'OneDrive'],
  ['rclone', 'Existing rclone remote'],
  ['local', 'Local or mounted folder'],
];

const STATUS: Record<ConnectionStatus, [string, string]> = {
  not_tested: ['Not tested', 'grey'],
  available: ['Available', 'green'],
  needs_authentication: ['Needs authentication', 'amber'],
  unavailable: ['Unavailable', 'red'],
};

function Connections() {
  const { state, refresh, notify } = useStore();
  const [editing, setEditing] = useState<Connection | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const test = async (c: Connection) => {
    setBusy(c.id);
    try {
      await call('test_connection', { id: c.id });
      await refresh();
    } catch (e) {
      notify(errorText(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (c: Connection) => {
    try {
      await call('delete_connection', { id: c.id });
      await refresh();
    } catch (e) {
      notify(errorText(e), 'error');
    }
  };

  return (
    <div role="tabpanel" aria-label="Connections">
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <div className="grow">
            <h2>Saved connections</h2>
            <div className="muted">Remote locations plans can use as a source or destination.</div>
          </div>
          <button type="button" className="btn primary" onClick={() => setEditing('new')}>
            <Plus size={16} /> Add connection
          </button>
        </div>
        {state.connections.length === 0 ? (
          <div className="empty">No connections yet. Local folders do not need one.</div>
        ) : (
          <div className="grid-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Address</th>
                  <th>Status</th>
                  <th>Checked</th>
                  <th style={{ width: 56 }} />
                </tr>
              </thead>
              <tbody>
                {state.connections.map((c) => {
                  const [text, color] = STATUS[c.status] ?? STATUS.not_tested;
                  return (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{KINDS.find(([k]) => k === c.kind)?.[1] ?? c.kind}</td>
                      <td className="wrap">{c.address || c.remote || c.options.path || '—'}</td>
                      <td>
                        <span className="cell-flex" title={c.message}>
                          <span className={`dot ${color}`} />
                          {busy === c.id ? 'Testing…' : text}
                        </span>
                      </td>
                      <td className="num">{c.last_checked ? formatWhen(c.last_checked) : '—'}</td>
                      <td>
                        <Menu
                          label={`Actions for ${c.name}`}
                          items={[
                            ['Test connection', () => test(c)],
                            ['Edit…', () => setEditing(c)],
                            ['Delete', () => remove(c), undefined, true],
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {state.connections.some((c) => c.message && c.status !== 'available') && (
          <div className="panel-foot muted">{state.connections.filter((c) => c.message && c.status !== 'available').map((c) => `${c.name}: ${c.message}`).join(' · ')}</div>
        )}
      </section>
      {!state.capabilities.providers.rclone.available && (
        <div className="notice warn" style={{ marginTop: 12 }}>
          <AlertTriangle size={18} />
          <div className="grow">rclone was not found. Cloud, SFTP, WebDAV and S3 connections cannot be tested or used until it is installed.</div>
        </div>
      )}
      {editing && <ConnectionDialog connection={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ConnectionDialog({ connection, onClose }: { connection: Connection | null; onClose: () => void }) {
  const { refresh, notify } = useStore();
  const [form, setForm] = useState({
    name: connection?.name ?? '',
    kind: (connection?.kind ?? 'sftp') as ConnectionKind,
    address: connection?.address ?? '',
    user: connection?.user ?? '',
    port: connection?.port ? String(connection.port) : '',
    remote: connection?.remote ?? '',
    path: connection?.options.path ?? '',
  });
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const local = form.kind === 'local';
  const named = form.kind === 'rclone';
  const oauth = form.kind === 'gdrive' || form.kind === 'onedrive';

  const submit = async () => {
    setSaving(true);
    try {
      const saved = await call<Connection>('save_connection', {
        connection: {
          id: connection?.id ?? '',
          name: form.name,
          kind: form.kind,
          address: form.address.trim(),
          user: form.user.trim(),
          port: form.port ? Number(form.port) : null,
          remote: form.remote.trim(),
          options: { path: form.path.trim() },
        },
        secret,
      });
      await refresh();
      notify(`Saved connection "${saved.name}"`, 'success');
      onClose();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={connection ? 'Edit connection' : 'Add connection'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={saving || !form.name.trim()} onClick={submit}>
            Save connection
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label htmlFor="c-name">Name</label>
        <input id="c-name" className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
        <label>Type</label>
        <Select label="Connection type" value={form.kind} options={KINDS} onChange={(v) => set('kind', v)} width="100%" />
        {local && (
          <>
            <label htmlFor="c-path">Folder</label>
            <input id="c-path" className="input" value={form.path} onChange={(e) => set('path', e.target.value)} placeholder="/mnt/backup" spellCheck={false} />
          </>
        )}
        {named && (
          <>
            <label htmlFor="c-remote">Remote name</label>
            <input id="c-remote" className="input" value={form.remote} onChange={(e) => set('remote', e.target.value)} placeholder="Name from rclone config" spellCheck={false} />
          </>
        )}
        {!local && !named && !oauth && (
          <>
            <label htmlFor="c-address">{form.kind === 'webdav' ? 'URL' : 'Host'}</label>
            <input id="c-address" className="input" value={form.address} onChange={(e) => set('address', e.target.value)} spellCheck={false} />
            <label htmlFor="c-user">User</label>
            <input id="c-user" className="input" value={form.user} onChange={(e) => set('user', e.target.value)} spellCheck={false} />
            <label htmlFor="c-port">Port</label>
            <input id="c-port" className="input" type="number" value={form.port} onChange={(e) => set('port', e.target.value)} placeholder="Default" />
            <label htmlFor="c-secret">{form.kind === 's3' ? 'Secret key' : 'Password'}</label>
            <input
              id="c-secret"
              className="input"
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={connection ? 'Leave empty to keep the stored secret' : ''}
            />
            <span className="hint">Stored in the operating system credential store, never in Backurau files.</span>
          </>
        )}
        {oauth && (
          <span className="hint">
            Authorize this account with rclone first ({isDesktop() ? 'rclone config' : 'on the computer running the service'}), then enter the remote name below.
          </span>
        )}
        {oauth && (
          <>
            <label htmlFor="c-remote2">Remote name</label>
            <input id="c-remote2" className="input" value={form.remote} onChange={(e) => set('remote', e.target.value)} spellCheck={false} />
          </>
        )}
      </div>
      {error && (
        <div className="notice error" role="alert" style={{ marginTop: 12 }}>
          <AlertTriangle size={18} />
          <div className="grow">{error}</div>
        </div>
      )}
    </Dialog>
  );
}
