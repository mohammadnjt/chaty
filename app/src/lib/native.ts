// Small bridge to the Nitron Android shell; every call is a no-op in a browser.
import { pushEnabled } from './push';

interface NitronBridge {
  showNotification?: (title: string, message: string) => void;
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
  contacts?: () => string;
}

const appBridge = () => (window as unknown as { ChatyApp?: ChatyAppBridge }).ChatyApp;

/**
 * In the Android app, gets Android's permission for the microphone (and
 * camera) the moment a call or a voice message needs them, never before:
 * asking from inside getUserMedia can leave it waiting forever. Resolves whether the microphone may be used; elsewhere
 * the browser asks by itself, so it's always true.
 */
export async function ensureMediaPermission(camera: boolean): Promise<boolean> {
  const app = appBridge();
  if (!app) return true;
  const mic = () => {
    try {
      return app.hasPermissions('RECORD_AUDIO');
    } catch {
      return true;
    }
  };
  if (mic() && (!camera || app.hasPermissions('CAMERA'))) return true;
  await askPermissions(camera ? 'RECORD_AUDIO,CAMERA' : 'RECORD_AUDIO');
  return mic();
}

/** Shows Android's prompt for the permissions (e.g. "RECORD_AUDIO,CAMERA") and waits for the answer. */
export function askPermissions(names: string): Promise<void> {
  const app = appBridge();
  if (!app) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('chaty-permissions', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, 60_000);
    window.addEventListener('chaty-permissions', done);
    app.requestPermissions(names);
  });
}

export interface PhoneContact {
  name: string;
  phone: string;
}

/** Whether this is the Android app, which can read the phone's contacts. */
export const contactsAvailable = () => typeof appBridge()?.contacts === 'function';

export function hasContactsPermission(): boolean {
  try {
    return !!appBridge()?.hasPermissions('READ_CONTACTS');
  } catch {
    return false;
  }
}

/**
 * The phone's contacts, one entry per number; null if they can't be read.
 * With ask, shows Android's prompt first when needed.
 */
export async function readContacts(ask: boolean): Promise<PhoneContact[] | null> {
  const app = appBridge();
  if (!app?.contacts) return null;
  if (!hasContactsPermission()) {
    if (!ask) return null;
    await askPermissions('READ_CONTACTS');
    if (!hasContactsPermission()) return null;
  }
  try {
    const raw = app.contacts();
    return raw ? (JSON.parse(raw) as PhoneContact[]) : null;
  } catch {
    return null;
  }
}

export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}
