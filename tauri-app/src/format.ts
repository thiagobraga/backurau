export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 2024-11-02 10:15, as in the comparison table. */
export function formatStamp(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "Today, 14:32" / "Yesterday, 18:20" / "Oct 30, 11:05". */
export function formatWhen(seconds: number): string {
  const d = new Date(seconds * 1000);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday, ${time}`;
  const month = d.toLocaleString('en', { month: 'short' });
  const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${month} ${d.getDate()}${year}, ${time}`;
}

/** Short sidebar label: "Last run 14:32" / "Yesterday 18:20" / "3 days ago". */
export function formatShort(seconds: number): string {
  const d = new Date(seconds * 1000);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return time;
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days <= 1) return `Yesterday ${time}`;
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Joins a root (local path or connection URL) and a relative path for display. */
export function joinPath(root: string, rel: string): string {
  if (!rel) return root;
  return `${root.replace(/\/+$/, '')}/${rel}`;
}
