// Push notifications in browsers and the installed web app, through Firebase
// Cloud Messaging. The service worker (public/sw.js) shows them. The Android
// app can't use web push: its WebView has no Push API.
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

async function firebase() {
  const [{ getApps, initializeApp }, m] = await Promise.all([import('firebase/app'), import('firebase/messaging')]);
  if (!(await m.isSupported())) return null;
  return { m, messaging: m.getMessaging(getApps()[0] ?? initializeApp(firebaseConfig)) };
}

/** Whether this browser can get push notifications at all. */
export function pushAvailable(): boolean {
  return (
    import.meta.env.PROD &&
    !isNativeShell &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export const pushPermission = (): NotificationPermission => ('Notification' in window ? Notification.permission : 'denied');

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
  if (!pushAvailable()) return false;
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

/** This browser stops getting notifications for the account (sign out, or turned off). */
export async function disablePush() {
  const token = storage.get(TOKEN);
  if (!token) return;
  storage.remove(TOKEN);
  await api.unregisterPush(token).catch(() => {});
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
