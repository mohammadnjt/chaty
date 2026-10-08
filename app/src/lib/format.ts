const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const longWeekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const fullDateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const DAY = 86_400_000;

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export const formatTime = (t: number) => timeFmt.format(t);

/** Chat list style: 9:24 AM · Yesterday · Mon · Mar 4 */
export function formatListTime(t: number): string {
  const today = startOfDay(Date.now());
  if (t >= today) return timeFmt.format(t);
  if (t >= today - DAY) return 'Yesterday';
  if (t >= today - 6 * DAY) return weekdayFmt.format(t);
  return new Date(t).getFullYear() === new Date().getFullYear() ? dateFmt.format(t) : fullDateFmt.format(t);
}

/** Separator between days in a conversation. */
export function formatDay(t: number): string {
  const today = startOfDay(Date.now());
  if (t >= today) return 'Today';
  if (t >= today - DAY) return 'Yesterday';
  if (t >= today - 6 * DAY) return longWeekdayFmt.format(t);
  return new Date(t).getFullYear() === new Date().getFullYear() ? dateFmt.format(t) : fullDateFmt.format(t);
}

export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

export function formatLastSeen(t: number): string {
  if (!t) return 'last seen recently';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'last seen just now';
  if (diff < 3_600_000) return `last seen ${Math.floor(diff / 60_000)} min ago`;
  const today = startOfDay(Date.now());
  if (t >= today) return `last seen today at ${timeFmt.format(t)}`;
  if (t >= today - DAY) return `last seen yesterday at ${timeFmt.format(t)}`;
  return `last seen ${dateFmt.format(t)}`;
}

/** 0:07 · 12:45 · 1:02:03 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = Array.from(parts[0])[0] ?? '';
  const second = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? '') : '';
  return (first + second).toUpperCase();
}

export function formatBytes(n = 0): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
