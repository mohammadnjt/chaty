// Push notifications through Firebase Cloud Messaging. In browsers and the
// installed web app the service worker (public/sw.js) shows them; the Android
// app gets them natively (its WebView has no Push API) and hands the page its
// push address through window.ChatyApp.
import { api } from './api';
import { isNativeShell, storage } from './config';
import { socket } from './socket';

// Public web settings of the Firebase project (safe to ship to browsers).
const firebaseConfig = {
  apiKey: 'AIzaSyBZsHZvLsJrjcLstEyMIt0yPfPWuEUWZTI',
  authDomain: 'chaty-40118.firebaseapp.com',
  projectId: 'chaty-40118',
  storageBucket: 'chaty-40118.firebasestorage.app',
  messagingSenderId: '862097941892',
  appId: '1:862097941892:web:bd0b94f6af0c468a2be9d1',
};
const VAPID_KEY = 'BL_oaeZ2ilS6IZXvePyoqlnk1BxBIUtfvfCvOwiALVNcumcxYPwmqWGbwTY0caBizCLzhEXUg8XDxGKoD5BotSU';
const TOKEN = 'chaty.pushToken';
const OFF = 'chaty.pushOff'; // turned off in Settings

interface AppPush {
  pushToken?: () => void;
}
const appPush = () => (window as unknown as { ChatyApp?: AppPush }).ChatyApp;

/** The Android app's push address ("" if Firebase isn't available on this phone). */
function appToken(): Promise<string> {
  return new Promise((resolve) => {
    const done = (e: Event) => {
      window.removeEventListener('chaty-push-token', done);
      clearTimeout(timer);
      resolve((e as CustomEvent<string>).detail ?? '');
    };
    const timer = window.setTimeout(() => done(new CustomEvent('chaty-push-token', { detail: '' })), 30_000);
    window.addEventListener('chaty-push-token', done);
    appPush()!.pushToken!();
  });
}

async function firebase() {
  const [{ getApps, initializeApp }, m] = await Promise.all([import('firebase/app'), import('firebase/messaging')]);
  if (!(await m.isSupported())) return null;
  return { m, messaging: m.getMessaging(getApps()[0] ?? initializeApp(firebaseConfig)) };
}

/** Whether this browser can get push notifications at all. */
export function pushAvailable(): boolean {
  if (isNativeShell) return !!appPush()?.pushToken;
  return (
    import.meta.env.PROD &&
    !isNativeShell &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export const pushPermission = (): NotificationPermission =>
  isNativeShell ? 'granted' : 'Notification' in window ? Notification.permission : 'denied';

/** Push is on for this browser. */
export const pushEnabled = () => !!storage.get(TOKEN) && pushPermission() === 'granted';

let enabling: Promise<boolean> | null = null;

/**
 * Turns push on for this browser and signed-in account. With ask, it may show
 * the browser's permission prompt, so call it from a tap.
 */
export function enablePush(ask: boolean): Promise<boolean> {
  // One registration at a time: two at once leave Firebase with a stale token.
  enabling ??= register(ask).finally(() => (enabling = null));
  return enabling;
}

async function register(ask: boolean): Promise<boolean> {
  if (!pushAvailable() || (!ask && storage.get(OFF))) return false;
  storage.remove(OFF);
  if (isNativeShell) {
    // Android asks about notifications itself (Android 13+).
    const token = await appToken();
    if (!token) return false;
    await api.registerPush(token, 'android');
    storage.set(TOKEN, token);
    return true;
  }
  let permission = Notification.permission;
  if (permission === 'default' && ask) permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  const fb = await firebase();
  if (!fb) return false;
  const token = await fb.m.getToken(fb.messaging, {
    vapidKey: VAPID_KEY,
    serviceWorkerRegistration: await navigator.serviceWorker.ready,
  });
  if (!token) return false;
  await api.registerPush(token, 'web');
  storage.set(TOKEN, token);
  return true;
}

/** This device stops getting notifications for the account: signing out, or turned off (byChoice). */
export async function disablePush(byChoice = false) {
  if (byChoice) storage.set(OFF, '1');
  const token = storage.get(TOKEN);
  if (!token) return;
  storage.remove(TOKEN);
  await api.unregisterPush(token).catch(() => {});
  if (isNativeShell) return;
  try {
    const fb = await firebase();
    if (fb) await fb.m.deleteToken(fb.messaging);
  } catch {
    /* already gone */
  }
}

// The server pushes only to people who don't have the app in front of them,
// so tell it when this device goes to the background and back.
let background = false;

function reportVisibility() {
  socket.send('visibility', { hidden: background || document.visibilityState === 'hidden' });
}

document.addEventListener('visibilitychange', reportVisibility);
// The Android app says when it's sent to the background (its WebView stays "visible").
window.addEventListener('chaty-app-state', (e) => {
  background = (e as CustomEvent<string>).detail === 'background';
  reportVisibility();
});
socket.on('hello', reportVisibility);

// Firebase can hand the Android app a new push address at any time.
window.addEventListener('chaty-push-token', (e) => {
  const token = (e as CustomEvent<string>).detail;
  if (token && storage.get(TOKEN) && storage.get(TOKEN) !== token) {
    storage.set(TOKEN, token);
    void api.registerPush(token, 'android').catch(() => {});
  }
});
