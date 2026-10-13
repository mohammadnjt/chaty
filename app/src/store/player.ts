// The voice message player. There's one for the whole app, so a message keeps
// playing when you leave its chat, with a bar at the top like Telegram's, and
// the next voice message in the chat plays after it. When you leave the app
// it keeps going: the Android app shows a media notification for it
// (window.ChatyPlayer), browsers do the same through the Media Session API.
import { create } from 'zustand';
import { useCall } from '../call/engine';
import { mediaUrl, storage } from '../lib/config';
import type { Message } from '../lib/types';
import { nameOf, titleOf, useChat } from './chat';
import { toast } from './toast';

interface PlayerState {
  msg: Message | null;
  playing: boolean;
  position: number; // ms
  duration: number; // ms
  rate: number;
}

const RATE = 'chaty.voiceRate';
const RATES = [1, 1.5, 2];

export const usePlayer = create<PlayerState>(() => ({
  msg: null,
  playing: false,
  position: 0,
  duration: 0,
  rate: RATES.includes(Number(storage.get(RATE))) ? Number(storage.get(RATE)) : 1,
}));
const get = usePlayer.getState;
const set = usePlayer.setState;

/** Whether a and b are the same message (one may still be sending). */
export const sameMessage = (a: Message | null, b: Message) =>
  !!a && ((!!a.id && a.id === b.id) || (!!a.clientId && a.clientId === b.clientId));

interface NativePlayer {
  show: (json: string) => void;
  hide: () => void;
}
const nativePlayer = () => (window as unknown as { ChatyPlayer?: NativePlayer }).ChatyPlayer;
const session = typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;

let el: HTMLAudioElement | null = null;
let startAt = 0; // seconds to jump to once the next message has loaded

function audio(): HTMLAudioElement {
  if (el) return el;
  const a = new Audio();
  a.preload = 'auto';
  a.ontimeupdate = () => set({ position: a.currentTime * 1000 });
  a.ondurationchange = () => {
    // Recorded voice (WebM) often doesn't say how long it is; the message does.
    if (isFinite(a.duration) && a.duration > 0) set({ duration: a.duration * 1000 });
  };
  a.onloadedmetadata = () => {
    if (startAt) a.currentTime = startAt;
    startAt = 0;
  };
  a.onplay = () => {
    set({ playing: true });
    sync();
  };
  a.onpause = () => {
    if (a.ended) return;
    set({ playing: false });
    sync();
  };
  a.onended = playNext;
  a.onerror = () => {
    if (!get().msg) return;
    toast("Couldn't play this voice message");
    stopVoice();
  };
  el = a;
  return a;
}

/** Plays a voice message (from `at`, 0..1), or pauses / resumes it if it's the one playing. */
export function playVoice(msg: Message, at?: number) {
  const s = get();
  const a = audio();
  if (sameMessage(s.msg, msg)) {
    if (at !== undefined) seekVoice(at);
    if (a.paused) resumeVoice();
    else if (at === undefined) a.pause();
    return;
  }
  const duration = msg.duration ?? 0;
  startAt = at && duration ? (at * duration) / 1000 : 0;
  a.src = msg.localUrl || mediaUrl(msg.mediaUrl);
  a.defaultPlaybackRate = a.playbackRate = s.rate;
  set({ msg, playing: false, position: startAt * 1000, duration });
  void a.play().catch(() => {
    set({ playing: false });
    sync();
  });
}

export function resumeVoice() {
  const a = el;
  if (!a || !get().msg) return;
  if (a.ended) a.currentTime = 0;
  void a.play().catch(() => {});
}

export function pauseVoice() {
  el?.pause();
}

export function toggleVoice() {
  if (el?.paused) resumeVoice();
  else pauseVoice();
}

/** Jumps to `at` (0..1) of the message playing. */
export function seekVoice(at: number) {
  const a = el;
  const { duration } = get();
  if (!a || !duration) return;
  a.currentTime = (Math.min(1, Math.max(0, at)) * duration) / 1000;
  set({ position: a.currentTime * 1000 });
  sync();
}

/** Closes the player. */
export function stopVoice() {
  startAt = 0;
  if (el) {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }
  set({ msg: null, playing: false, position: 0, duration: 0 });
  sync();
}

export function cycleRate() {
  const rate = RATES[(RATES.indexOf(get().rate) + 1) % RATES.length];
  storage.set(RATE, String(rate));
  if (el) el.defaultPlaybackRate = el.playbackRate = rate;
  set({ rate });
  sync();
}

// When one ends, the next voice message in the chat plays, like in Telegram.
function playNext() {
  const cur = get().msg;
  const list = cur ? (useChat.getState().messages[cur.conversationId] ?? []) : [];
  const next = cur?.id ? list.find((m) => m.id > cur.id && m.type === 'audio' && !m.deletedAt) : undefined;
  if (next) playVoice(next);
  else stopVoice();
}

/** Who and where, for the bar and the notification. */
export function describeVoice(msg: Message): { title: string; text: string } {
  const conv = useChat.getState().conversations[msg.conversationId];
  const title = msg.forwardedFrom || nameOf(msg.senderId, conv);
  const chat = conv ? titleOf(conv, useChat.getState().me) : '';
  return { title, text: chat && chat !== title ? `Voice message · ${chat}` : 'Voice message' };
}

// Tells the Android app's notification and the browser's media controls what's playing.
function sync() {
  const { msg, playing, rate, duration } = get();
  const position = (el?.currentTime ?? 0) * 1000;
  try {
    if (!msg) nativePlayer()?.hide();
    else {
      const { title, text } = describeVoice(msg);
      const url = `/app/#/chat/${msg.conversationId}`;
      nativePlayer()?.show(JSON.stringify({ title, text, url, playing, position, duration, rate }));
    }
  } catch {
    /* older app */
  }
  if (!session) return;
  try {
    if (!msg) {
      session.metadata = null;
      session.playbackState = 'none';
      return;
    }
    const { title, text } = describeVoice(msg);
    session.metadata = new MediaMetadata({
      title,
      artist: text,
      artwork: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
    });
    session.playbackState = playing ? 'playing' : 'paused';
    if (duration) session.setPositionState?.({ duration: duration / 1000, position: Math.min(position, duration) / 1000, playbackRate: rate });
  } catch {
    /* media session is best effort */
  }
}

if (session) {
  const on = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
    try {
      session.setActionHandler(action, fn);
    } catch {
      /* not supported here */
    }
  };
  on('play', resumeVoice);
  on('pause', pauseVoice);
  on('stop', stopVoice);
  on('seekto', (d) => {
    const { duration } = get();
    if (d.seekTime !== undefined && duration) seekVoice((d.seekTime * 1000) / duration);
  });
}

// The Android app's notification, lock screen and headset buttons.
window.addEventListener('chaty-player', (e) => {
  const action = (e as CustomEvent<string>).detail;
  if (action === 'play') resumeVoice();
  else if (action === 'pause') pauseVoice();
  else if (action === 'stop') stopVoice();
  else if (action.startsWith('seek:')) {
    const { duration } = get();
    if (duration) seekVoice(Number(action.slice(5)) / duration);
  }
});

// A call takes over the audio.
useCall.subscribe((s, prev) => {
  if (s.phase !== 'idle' && prev.phase === 'idle') pauseVoice();
});
