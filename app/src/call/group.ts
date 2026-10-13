// Group voice calls. A group has at most one call: any member starts it,
// members join and leave as they like, and it ends when the last one leaves.
// Audio always goes through the server (see relay.ts), so it works on any
// network where chatting does: your microphone goes out as one stream and
// each of the others comes in as theirs. A newcomer can only decode a stream
// from its start, so everyone starts a fresh one when someone joins.
import { create } from 'zustand';
import { callAudio, ensureMediaPermission, vibrate } from '../lib/native';
import { socket } from '../lib/socket';
import { playHangup, playRingtone, stopTones } from '../lib/sounds';
import type { User } from '../lib/types';
import { useChat } from '../store/chat';
import { toast } from '../store/toast';
import { useCall } from './engine';
import { RelayReceiver, RelaySender, relaySupported, type RelayStart } from './relay';

export interface GroupRoom {
  conversationId: number;
  participants: number[];
  startedBy: number;
  startedAt: number;
}

interface GroupCallState {
  rooms: Record<number, GroupRoom>; // calls going on in your groups
  ringing: { conversationId: number; from: User } | null; // someone started one
  conversationId: number | null; // the call you're in
  phase: 'idle' | 'joining' | 'active';
  muted: boolean;
  speaker: boolean;
  route: string; // Android app: speaker | earpiece | wired | bluetooth | media
  minimized: boolean;
  peersMuted: Record<number, boolean>;
}

const left = {
  conversationId: null,
  phase: 'idle' as const,
  muted: false,
  speaker: true,
  route: '',
  minimized: false,
  peersMuted: {},
};

export const useGroupCall = create<GroupCallState>(() => ({ rooms: {}, ringing: null, ...left }));
const get = useGroupCall.getState;
const set = useGroupCall.setState;

let local: MediaStream | null = null;
let sender: RelaySender | null = null;
const receivers = new Map<number, RelayReceiver>();
let ringTimer: number | undefined;

const ENDED: Record<string, string> = {
  disabled: 'Calls are turned off by the admin',
  invalid: "This call can't be joined",
  already_in_call: "You're already in a call",
  elsewhere: 'You joined this call on another device',
  removed: "You're no longer in this group",
};

const me = () => useChat.getState().me;

function signal(payload: unknown, to = 0) {
  const id = get().conversationId;
  if (id) socket.send('gcall:signal', { conversationId: id, to, payload });
}

/** In the Android app the route sets loudness; elsewhere "speaker off" just plays quieter. */
const volume = () => (callAudio.available() || get().speaker ? 1 : 0.45);

function receiver(uid: number): RelayReceiver {
  let r = receivers.get(uid);
  if (!r) {
    r = new RelayReceiver(() => signal({ reset: true }, uid));
    r.setVolume(volume());
    receivers.set(uid, r);
  }
  return r;
}

function putRoom(room: GroupRoom) {
  set((s) => {
    const rooms = { ...s.rooms };
    if (room.participants.length) rooms[room.conversationId] = room;
    else delete rooms[room.conversationId];
    return { rooms };
  });
}

function stopRinging() {
  clearTimeout(ringTimer);
  if (get().ringing) {
    stopTones();
    set({ ringing: null });
  }
}

/** Lets go of the microphone and everyone's audio. */
function cleanup() {
  sender?.stop();
  sender = null;
  receivers.forEach((r) => r.stop());
  receivers.clear();
  local?.getTracks().forEach((t) => t.stop());
  local = null;
  if (get().phase === 'active') callAudio.stop();
  set(left);
}

// ---------- actions ----------

/** Starts the group's call, or joins the one going on. */
export async function joinGroupCall(conversationId: number) {
  const s = get();
  if (s.conversationId === conversationId) {
    set({ minimized: false });
    return;
  }
  if (useCall.getState().phase !== 'idle') {
    toast("You're already in a call");
    return;
  }
  if (s.phase !== 'idle') leaveGroupCall();
  stopRinging();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    toast('Calls need a secure connection: open the app over https://');
    return;
  }
  if (!relaySupported(false)) {
    toast("This device can't take part in group calls");
    return;
  }
  set({ ...left, conversationId, phase: 'joining' });
  try {
    if (!(await ensureMediaPermission(false))) throw new DOMException('', 'NotAllowedError');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (get().conversationId !== conversationId) {
      stream.getTracks().forEach((t) => t.stop()); // left while the mic was starting
      return;
    }
    local = stream;
  } catch (e) {
    if (get().conversationId === conversationId) cleanup();
    toast((e as DOMException)?.name === 'NotAllowedError' ? 'Allow microphone access to join calls' : "Couldn't start your microphone");
    return;
  }
  socket.send('gcall:join', { conversationId }); // or once the connection is back ("hello")
}

export function leaveGroupCall() {
  const id = get().conversationId;
  if (!id) return;
  socket.send('gcall:leave', { conversationId: id });
  if (get().phase === 'active') playHangup();
  cleanup();
}

export function declineGroupCall() {
  stopRinging();
}

export function toggleGroupMute() {
  const muted = !get().muted;
  local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  set({ muted });
  signal({ muted });
}

export function toggleGroupSpeaker() {
  const speaker = !get().speaker;
  set({ speaker });
  callAudio.setSpeaker(speaker);
  receivers.forEach((r) => r.setVolume(volume()));
}

export const setGroupMinimized = (minimized: boolean) => set({ minimized });

/** On signing out. */
export function resetGroupCalls() {
  leaveGroupCall();
  stopRinging();
  set({ rooms: {} });
}

// ---------- from the server ----------

socket.on('hello', () => {
  // The server sends the calls going on right after; any others ended meanwhile.
  set({ rooms: {} });
  const { conversationId, phase } = get();
  if (conversationId && phase !== 'idle' && local) socket.send('gcall:join', { conversationId }); // join again
});

socket.on('gcall:state', (room: GroupRoom) => {
  const before = new Set(get().rooms[room.conversationId]?.participants ?? []);
  putRoom(room);
  const s = get();
  if (s.ringing?.conversationId === room.conversationId && !room.participants.length) stopRinging();
  if (s.conversationId !== room.conversationId || s.phase !== 'active') return;
  // Someone (new, or back) needs our stream from its start.
  if (room.participants.some((id) => id !== me() && !before.has(id))) sender?.start();
  for (const [uid, r] of receivers) {
    if (!room.participants.includes(uid)) {
      r.stop();
      receivers.delete(uid);
    }
  }
});

socket.on('gcall:joined', (room: GroupRoom) => {
  if (get().conversationId !== room.conversationId || !local) return;
  putRoom(room);
  if (get().phase === 'joining') {
    set({ phase: 'active', speaker: true });
    callAudio.start(true); // loudspeaker, like a meeting
  }
  sender ??= new RelaySender(local, false, (start) => signal({ start }));
  sender.start();
  signal({ muted: get().muted });
});

socket.on('gcall:signal', (d: { conversationId: number; from: number; payload: { start?: RelayStart; reset?: boolean; muted?: boolean } }) => {
  if (d.conversationId !== get().conversationId || get().phase !== 'active') return;
  const p = d.payload;
  if (p.start) receiver(d.from).open(p.start);
  if (p.reset) sender?.start();
  if (typeof p.muted === 'boolean') set((s) => ({ peersMuted: { ...s.peersMuted, [d.from]: !!p.muted } }));
});

socket.on('gcall:ended', (d: { conversationId: number; reason: string }) => {
  if (d.conversationId !== get().conversationId) return;
  cleanup();
  toast(ENDED[d.reason] ?? 'Call ended');
});

socket.on('gcall:ring', (d: { conversationId: number; from: User }) => {
  if (get().phase !== 'idle' || get().ringing || useCall.getState().phase !== 'idle') return;
  set({ ringing: d });
  playRingtone();
  vibrate([400, 200, 400]);
  clearTimeout(ringTimer);
  ringTimer = window.setTimeout(stopRinging, 30_000);
});

// Audio from the others: [sender id, 4 bytes][generation][data].
socket.onBinary((buf) => {
  if (get().phase !== 'active' || buf.byteLength < 6) return;
  const from = new DataView(buf).getUint32(0);
  receiver(from).onChunk(new Uint8Array(buf, 4));
});

callAudio.onRoute((route) => {
  if (get().phase !== 'active') return;
  set({ route, ...(route === 'speaker' ? { speaker: true } : route === 'earpiece' ? { speaker: false } : {}) });
});
