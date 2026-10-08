// Hash routing: works from any static host and inside the APK, and the
// Android back button maps onto history.back().
import { useSyncExternalStore } from 'react';

const getPath = () => location.hash.replace(/^#/, '') || '/';

const ROUTE_EVENT = 'chaty:route';

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  window.addEventListener('popstate', cb);
  window.addEventListener(ROUTE_EVENT, cb);
  return () => {
    window.removeEventListener('hashchange', cb);
    window.removeEventListener('popstate', cb);
    window.removeEventListener(ROUTE_EVENT, cb);
  };
}

export const usePath = () => useSyncExternalStore(subscribe, getPath);

// Each history entry remembers how many in-app screens sit below it, so
// goBack() never walks out of the app.
const depth = (): number => (history.state as { chatyDepth?: number } | null)?.chatyDepth ?? 0;

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  if (getPath() === path) return;
  if (opts.replace) history.replaceState({ chatyDepth: depth() }, '', '#' + path);
  else history.pushState({ chatyDepth: depth() + 1 }, '', '#' + path);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

export function goBack(fallback = '/') {
  if (depth() > 0) history.back();
  else navigate(fallback, { replace: true });
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const a = path.split('/');
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}
