// Small bridge to the Nitron Android shell; every call is a no-op in a browser.

interface NitronBridge {
  showNotification?: (title: string, message: string) => void;
  requestCameraPermission?: () => void;
}

const bridge = () => (window as unknown as { Nitron?: NitronBridge }).Nitron;

export function notify(title: string, message: string) {
  if (document.visibilityState === 'visible') return;
  try {
    const n = bridge();
    if (n?.showNotification) {
      n.showNotification(title, message);
      return;
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body: message, icon: '/favicon.svg' });
    }
  } catch {
    /* notifications are best effort */
  }
}

export function requestMediaPermission() {
  try {
    bridge()?.requestCameraPermission?.();
  } catch {
    /* not in the shell */
  }
}

export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}
