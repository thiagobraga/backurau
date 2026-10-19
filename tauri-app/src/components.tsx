import { ChevronDown, FolderOpen, MoreHorizontal, X } from 'lucide-react';
import { createContext, ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import { isDesktop, pickFolder } from './api';
import type { Connection, RunStatus } from './types';

// ---------- file artwork: dimensional yellow folders, white documents with type labels ----------

const LABELS: Record<string, [string, string]> = {
  pdf: ['PDF', '#d32f2f'],
  xls: ['XLS', '#1e8e3e'],
  xlsx: ['XLS', '#1e8e3e'],
  csv: ['CSV', '#1e8e3e'],
  doc: ['DOC', '#1a5fd0'],
  docx: ['DOC', '#1a5fd0'],
  ppt: ['PPT', '#d0571a'],
  pptx: ['PPT', '#d0571a'],
  zip: ['ZIP', '#7a5c2e'],
};

export function FileIcon({ name, dir, missing }: { name?: string; dir?: boolean; missing?: boolean }) {
  if (dir) {
    return (
      <svg width="28" height="24" viewBox="0 0 28 24" aria-hidden="true">
        <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3h6.2l2.3 2.6h10.5A2.5 2.5 0 0 1 26 8.1V19a2.5 2.5 0 0 1-2.5 2.5h-19A2.5 2.5 0 0 1 2 19z" fill="#d99a1e" />
        <path d="M2 9.6A2.4 2.4 0 0 1 4.4 7.2h19.2A2.4 2.4 0 0 1 26 9.6V19a2.5 2.5 0 0 1-2.5 2.5h-19A2.5 2.5 0 0 1 2 19z" fill="url(#bk-fold)" />
        <path d="M2.6 9.2h22.8" stroke="#fff3c4" strokeOpacity=".7" />
        <defs>
          <linearGradient id="bk-fold" x1="0" y1="7" x2="0" y2="22" gradientUnits="userSpaceOnUse">
            <stop stopColor="#f8cf5c" />
            <stop offset="1" stopColor="#e9ac2c" />
          </linearGradient>
        </defs>
      </svg>
    );
  }
  const ext = name?.split('.').pop()?.toLowerCase() ?? '';
  const label = name && name.includes('.') ? LABELS[ext] : undefined;
  return (
    <svg width="24" height="28" viewBox="0 0 24 28" aria-hidden="true" opacity={missing ? 0.55 : 1}>
      <path d="M4 1.5h11l6 6V25a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 25V3a1.5 1.5 0 0 1 1-1.5z" fill="#fff" stroke="#c9c3b8" />
      <path d="M15 1.5V6a1.5 1.5 0 0 0 1.5 1.5H21" fill="#eee9e0" stroke="#c9c3b8" />
      {label && (
        <text x="12" y="21" textAnchor="middle" fontSize="6.5" fontWeight="700" fontFamily="Archivo, sans-serif" fill={label[1]}>
          {label[0]}
        </text>
      )}
    </svg>
  );
}

// ---------- form controls ----------

export function Checkbox({ checked, mixed, onChange, label, disabled }: { checked: boolean; mixed?: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(mixed);
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="check"
      checked={checked}
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="toggle" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  icon,
  width,
  disabled,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  label: string;
  icon?: ReactNode;
  width?: number | string;
  disabled?: boolean;
}) {
  return (
    <span className={`select${icon ? ' with-icon' : ''}`} style={{ width }}>
      {icon}
      <select value={value} aria-label={label} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
      <ChevronDown className="chev" size={18} />
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

const STATUS: Record<RunStatus, [string, string]> = {
  running: ['Running', 'amber'],
  completed: ['Completed', 'green'],
  completed_with_warnings: ['Completed with warnings', 'amber'],
  completed_with_conflicts: ['Completed with conflicts', 'amber'],
  failed: ['Failed', 'red'],
  canceled: ['Canceled', 'grey'],
  interrupted: ['Interrupted', 'red'],
};

export const statusLabel = (s: RunStatus) => STATUS[s]?.[0] ?? s;
export const statusColor = (s: RunStatus) => STATUS[s]?.[1] ?? 'grey';

export function StatusDot({ status }: { status: RunStatus }) {
  return <span className={`dot ${statusColor(status)}`} aria-hidden="true" />;
}

// ---------- folder / connection path picker ----------

/** A root is an absolute local path or `connection://<id>/<relative path>`. */
export function PathField({ value, onChange, connections, label, placeholder }: { value: string; onChange: (v: string) => void; connections: Connection[]; label: string; placeholder?: string }) {
  const match = value.match(/^connection:\/\/([^/]+)\/?(.*)$/);
  const source = match ? match[1] : 'local';
  const rel = match ? match[2] : value;
  const set = (src: string, path: string) => onChange(src === 'local' ? path : `connection://${src}/${path.replace(/^\/+/, '')}`);
  const options: [string, string][] = [['local', 'This computer'], ...connections.map((c) => [c.id, c.name] as [string, string])];
  return (
    <div className="path-field">
      {connections.length > 0 && <Select label={`${label} location`} value={source} options={options} onChange={(s) => set(s, '')} width={180} />}
      <input
        className="input"
        aria-label={label}
        value={rel}
        placeholder={source === 'local' ? (placeholder ?? '/absolute/path/to/folder') : 'Folder inside the connection (optional)'}
        onChange={(e) => set(source, e.target.value)}
        spellCheck={false}
      />
      {source === 'local' && isDesktop() && (
        <button
          type="button"
          className="icon-btn bordered"
          aria-label={`Browse for ${label.toLowerCase()}`}
          title="Browse"
          onClick={async () => {
            const picked = await pickFolder();
            if (picked) set('local', picked);
          }}
        >
          <FolderOpen size={18} />
        </button>
      )}
    </div>
  );
}

// ---------- dialog ----------

export function Dialog({ title, subtitle, onClose, children, footer, wide }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'));
        if (!items.length) return;
        const [a, b] = [items[0], items[items.length - 1]];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
        <div className="dialog-head">
          <div className="grow">
            <h2 id={id}>{title}</h2>
            {subtitle && <div className="subtitle">{subtitle}</div>}
          </div>
          <button type="button" className="icon-btn small" aria-label="Close" data-close onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- ellipsis menu ----------

export function Menu({ label, items, badge }: { label: string; items: [string, () => void, ReactNode?, boolean?][]; badge?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className={`icon-btn small${badge ? ' badge-dot' : ''}`} aria-label={label} aria-haspopup="menu" aria-expanded={open} title={label} onClick={() => setOpen(!open)}>
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map(([text, action, icon, danger]) => (
            <button
              key={text}
              type="button"
              role="menuitem"
              className={danger ? 'danger' : undefined}
              onClick={() => {
                setOpen(false);
                action();
              }}
            >
              {icon}
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- toasts ----------

export interface Toast { id: number; kind: 'info' | 'error' | 'success'; text: string }
type Notify = (text: string, kind?: Toast['kind']) => void;
export const ToastContext = createContext<Notify>(() => {});
export const useNotify = () => useContext(ToastContext);
