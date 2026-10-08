// Where the Chaty server lives. Empty means "same origin" (dev proxy, or the
// Go server serving this build). The APK runs from Nitron's local origin, so
// it always needs an explicit https:// address.

const KEY = 'chaty.server';

export const isNativeShell =
  location.hostname === 'appassets.androidplatform.net' || location.protocol === 'file:';

export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  },
};

export function normalizeServerUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

const buildDefault = normalizeServerUrl((import.meta.env.VITE_SERVER_URL as string | undefined) ?? '');

export function getServerUrl(): string {
  const saved = storage.get(KEY);
  return saved !== null ? saved : buildDefault;
}

export function setServerUrl(url: string) {
  storage.set(KEY, normalizeServerUrl(url));
}

export const needsServerUrl = () => isNativeShell && !getServerUrl();

export const apiUrl = (path: string) => getServerUrl() + path;

export function mediaUrl(path?: string): string {
  if (!path) return '';
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  return getServerUrl() + path;
}

export function wsUrl(token: string): string {
  const base = getServerUrl() || location.origin;
  return base.replace(/^http/i, 'ws') + '/ws?token=' + encodeURIComponent(token);
}
