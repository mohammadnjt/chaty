// Small bridge to the Nitron Android shell; every call is a no-op in a browser.
import { pushEnabled } from './push';

interface NitronBridge {
  showNotification?: (title: string, message: string) => void;
  requestCameraPermission?: () => void;
}

const bridge = () => (window as unknown as { Nitron?: NitronBridge }).Nitron;

export function notify(title: string, message: string) {
  // With push on, the server's notification covers it.
  if (document.visibilityState === 'visible' || pushEnabled()) return;
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
  debug?: () => string;
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
  /** How Android is playing the call, for call reports. */
  debug(): string {
    try {
      return audioBridge()?.debug?.() ?? '';
    } catch {
      return '';
    }
  },
  /** speaker | earpiece | wired | bluetooth | media (the phone decides), as reported by the app. */
  onRoute(fn: (route: string) => void) {
    const h = (e: Event) => fn((e as CustomEvent<string>).detail);
    window.addEventListener('chaty-audio-route', h);
    return () => window.removeEventListener('chaty-audio-route', h);
  },
};

interface ChatyAppBridge {
  hasPermissions: (names: string) => boolean;
  requestPermissions: (names: string) => void;
}

const appBridge = () => (window as unknown as { ChatyApp?: ChatyAppBridge }).ChatyApp;

/**
 * In the Android app, gets Android's permission for the microphone (and
 * camera) before a call uses them: asking from inside getUserMedia can leave
 * it waiting forever. Resolves whether the microphone may be used; elsewhere
 * the browser asks by itself, so it's always true.
 */
export function ensureMediaPermission(camera: boolean): Promise<boolean> {
  const app = appBridge();
  if (!app) return Promise.resolve(true);
  const mic = () => {
    try {
      return app.hasPermissions('RECORD_AUDIO');
    } catch {
      return true;
    }
  };
  if (mic() && (!camera || app.hasPermissions('CAMERA'))) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('chaty-permissions', done);
      clearTimeout(timer);
      resolve(mic());
    };
    const timer = window.setTimeout(done, 60_000);
    window.addEventListener('chaty-permissions', done);
    app.requestPermissions(camera ? 'RECORD_AUDIO,CAMERA' : 'RECORD_AUDIO');
  });
}

export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}
