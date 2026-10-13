// A newer Android app than this one, once the admin has published it: the
// header then shows an update arrow instead of the logo, with an "Update now"
// hint each time the app is opened. Browsers always load the latest web app,
// so this is for the Android app only.
import { create } from 'zustand';
import { api } from '../lib/api';
import { isNativeShell, mediaUrl } from '../lib/config';
import { appVisible, onAppVisibility } from '../lib/visibility';

declare const __APP_VERSION__: string;

interface UpdateState {
  version: string | null; // the newer version, if there is one
  url: string; // where to download it
  hint: boolean; // show "Update now"
}

export const useUpdate = create<UpdateState>(() => ({ version: null, url: '', hint: false }));

/** Whether version a is newer than b ("1.10.0" > "1.9.2"). */
function newer(a: string, b: string): boolean {
  const x = a.split('.').map((n) => parseInt(n, 10) || 0);
  const y = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

let checkedAt = 0;

/** Looks for a newer app (at most every 10 minutes) and shows the hint if there is one. */
export async function checkForUpdate() {
  if (!isNativeShell) return;
  if (Date.now() - checkedAt > 10 * 60_000) {
    checkedAt = Date.now();
    try {
      const app = (await api.publicConfig()).android;
      const version = app?.version && newer(app.version, __APP_VERSION__) ? app.version : null;
      useUpdate.setState({ version, url: app ? mediaUrl(app.url) : '' });
    } catch {
      checkedAt = 0; // offline: try again next time
    }
  }
  if (useUpdate.getState().version) useUpdate.setState({ hint: true });
}

export const hideUpdateHint = () => useUpdate.setState({ hint: false });

// Each time the app is opened or brought back.
void checkForUpdate();
onAppVisibility(() => appVisible() && void checkForUpdate());
