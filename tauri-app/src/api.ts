// One call surface for both adapters: Tauri `api` command on desktop, POST /api/{method} in a browser.
interface TauriGlobal {
  core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
  window: { getCurrentWindow(): { minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void> } };
}

declare global {
  interface Window { __TAURI__?: TauriGlobal }
}

export const tauri = (): TauriGlobal | undefined => window.__TAURI__;
export const isDesktop = () => Boolean(tauri());

const TOKEN_KEY = 'backurau-token';

export class AuthRequired extends Error {
  constructor() {
    super('Access token required');
  }
}

export function getToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Session storage can be blocked; the token then lasts until reload.
  }
  memoryToken = token;
}

let memoryToken = '';

export async function call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const t = tauri();
  if (t) return t.core.invoke<T>('api', { method, args });
  const token = getToken() || memoryToken;
  const response = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(args),
  });
  if (response.status === 401) throw new AuthRequired();
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

/** Native folder dialog on desktop; null when canceled or unavailable (web uses typed paths). */
export async function pickFolder(): Promise<string | null> {
  const t = tauri();
  if (!t) return null;
  return t.core.invoke<string | null>('pick_folder');
}

export function windowControl(action: 'minimize' | 'maximize' | 'close') {
  const w = tauri()?.window.getCurrentWindow();
  if (!w) return;
  if (action === 'minimize') void w.minimize();
  if (action === 'maximize') void w.toggleMaximize();
  if (action === 'close') void w.close();
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Something went wrong';
}
