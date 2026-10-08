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

interface ChatyAudioBridge {
  start: (video: boolean) => void;
  setSpeaker: (on: boolean) => void;
  stop: () => void;
}

const audioBridge = () => (window as unknown as { ChatyAudio?: ChatyAudioBridge }).ChatyAudio;

/**
 * Where call audio plays, in the Android app: loudspeaker for video, earpiece
 * for voice, Bluetooth or wired earphones when connected. Browsers (and older
 * app versions) choose for themselves, and every call here is then a no-op.
 */
export const callAudio = {
  available: () => !!audioBridge(),
  start(video: boolean) {
    try {
      audioBridge()?.start(video);
    } catch {
      /* best effort */
    }
  },
  setSpeaker(on: boolean) {
    try {
      audioBridge()?.setSpeaker(on);
    } catch {
      /* best effort */
    }
  },
  stop() {
    try {
      audioBridge()?.stop();
    } catch {
      /* best effort */
    }
  },
  /** speaker | earpiece | wired | bluetooth, as reported by the app. */
  onRoute(fn: (route: string) => void) {
    const h = (e: Event) => fn((e as CustomEvent<string>).detail);
    window.addEventListener('chaty-audio-route', h);
    return () => window.removeEventListener('chaty-audio-route', h);
  },
};

export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}
