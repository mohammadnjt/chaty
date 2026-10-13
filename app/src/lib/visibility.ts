// Whether the app is in front of the person. Browsers say so through
// document.visibilityState; the Android app's WebView stays "visible" in the
// background, so the app reports it itself ("chaty-app-state").
let background = false;
const listeners = new Set<() => void>();

export const appVisible = () => !background && document.visibilityState === 'visible';

/** Calls fn whenever the app is shown or hidden. */
export function onAppVisibility(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const changed = () => listeners.forEach((fn) => fn());

document.addEventListener('visibilitychange', changed);
window.addEventListener('chaty-app-state', (e) => {
  background = (e as CustomEvent<string>).detail === 'background';
  changed();
});
