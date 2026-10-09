// 1:1 voice/video calls. The Go server relays signaling (call:invite /
// accept / signal / end). Media goes peer-to-peer over WebRTC (through TURN
// when needed); if that can't connect in time — e.g. the network blocks
// WebRTC — both sides switch to relaying media over the app's WebSocket.
import { create } from 'zustand';
import { isNativeShell } from '../lib/config';
import { uid } from '../lib/format';
import { callAudio, notify, requestMediaPermission } from '../lib/native';
import { socket } from '../lib/socket';
import { playHangup, playRingback, playRingtone, releaseCallTones, stopTones } from '../lib/sounds';
import type { CallKind, User } from '../lib/types';
import { useConfig } from '../store/config';
import { toast } from '../store/toast';
import { MediaRelay, relaySupported, type RelaySignal } from './relay';

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';

export interface CallState {
  phase: CallPhase;
  callId: string | null;
  kind: CallKind;
  direction: 'outgoing' | 'incoming';
  peer: User | null;
  conversationId: number | null;
  status: string;
  startedAt: number | null;
  muted: boolean;
  cameraOff: boolean;
  speaker: boolean;
  facing: 'user' | 'environment';
  local: MediaStream | null;
  remote: MediaStream | null;
  peerMuted: boolean;
  peerCameraOff: boolean;
  minimized: boolean;
  relay: boolean; // media goes through the server
  audioRoute: string; // Android app: speaker | earpiece | wired | bluetooth
}

const idle: CallState = {
  phase: 'idle',
  callId: null,
  kind: 'audio',
  direction: 'outgoing',
  peer: null,
  conversationId: null,
  status: '',
  startedAt: null,
  muted: false,
  cameraOff: false,
  speaker: true,
  facing: 'user',
  local: null,
  remote: null,
  peerMuted: false,
  peerCameraOff: false,
  minimized: false,
  relay: false,
  audioRoute: '',
};

export const useCall = create<CallState>(() => idle);
const get = useCall.getState;
const set = useCall.setState;

let pc: RTCPeerConnection | null = null;
let queuedCandidates: RTCIceCandidateInit[] = [];
let signalChain: Promise<void> = Promise.resolve();
let remoteTracks: MediaStreamTrack[] = [];
let resetTimer: number | undefined;
let failTimer: number | undefined;
let resumeTimer: number | undefined;
let restarts = 0;
let p2pTimer: number | undefined;
let reportTimers: number[] = [];
let relay: MediaRelay | null = null;

export const relayElement = () => relay?.element ?? null;

// Relayed media can arrive a moment before we've switched to the relay ourselves.
let earlyChunks: ArrayBuffer[] = [];
socket.onBinary((buf) => {
  if (relay) relay.onChunk(buf);
  else if (get().callId && earlyChunks.length < 100) earlyChunks.push(buf);
});
const historyListeners = new Set<() => void>();

export const onCallHistoryChanged = (fn: () => void) => {
  historyListeners.add(fn);
  return () => historyListeners.delete(fn);
};

class CallError extends Error {}

const END_TEXT: Record<string, string> = {
  rejected: 'Call declined',
  busy: 'Busy on another call',
  unavailable: 'Not reachable right now',
  timeout: 'No answer',
  ended: 'Call ended',
  cancelled: 'Missed call',
  disconnected: 'Call ended',
  invalid: "This call can't be placed",
  already_in_call: "You're already in a call",
  gone: 'Call is no longer available',
  failed: 'Connection failed',
  offline: 'Connection lost',
  disabled: 'Calls are turned off by the admin',
  blocked: "You can't call this user",
};

function signal(payload: unknown) {
  const callId = get().callId;
  if (callId) socket.send('call:signal', { callId, payload });
}

function sendMediaState() {
  const { muted, cameraOff } = get();
  signal({ media: { muted, cameraOff } });
}

const callSettings = () => useConfig.getState().calls;

/** In the Android app the route (earpiece/speaker) sets loudness; elsewhere "speaker off" just plays quieter. */
export const playbackVolume = (speaker: boolean) => (callAudio.available() || speaker ? 1 : 0.45);

// Media is ready: let the Android app route the sound (no-op elsewhere).
function startAudio(kind: CallKind) {
  set({ speaker: callAudio.available() ? kind === 'video' : true });
  callAudio.start(kind === 'video');
}

callAudio.onRoute((route) => {
  if (!get().callId) return;
  set({ audioRoute: route, ...(route === 'speaker' ? { speaker: true } : route === 'earpiece' ? { speaker: false } : {}) });
});

/** Use the server relay right away (admin setting, or no WebRTC in this browser). */
function wantsRelayOnly() {
  return callSettings().mode === 'relay' || typeof RTCPeerConnection === 'undefined';
}

function startRelay() {
  const { local, kind, callId, phase } = get();
  if (relay || !local || !callId || phase === 'ended' || phase === 'idle') return;
  if (!relaySupported(kind === 'video')) {
    socket.send('call:end', { callId });
    finish(callId, 'failed', { text: "This device can't relay calls" });
    return;
  }
  clearTimeout(p2pTimer);
  clearTimeout(failTimer);
  pc?.close();
  pc = null;
  // Smaller video keeps the relay smooth on slow links.
  local.getVideoTracks().forEach((t) => void t.applyConstraints({ width: 640, height: 480, frameRate: 20 }).catch(() => {}));
  relay = new MediaRelay(local, kind === 'video', (r: RelaySignal) => signal({ relay: r }), markActive);
  relay.setVolume(playbackVolume(get().speaker));
  set({ relay: true, remote: null, status: get().phase === 'active' ? '' : 'Connecting via server…' });
  relay.startSending();
  sendMediaState();
  for (const buf of earlyChunks.splice(0)) relay.onChunk(buf);
}

/** Ask both sides to move to the relay (WebRTC didn't connect in time). */
function switchToRelay() {
  if (relay || callSettings().mode === 'p2p') return false;
  signal({ relay: { switch: true } });
  startRelay();
  return true;
}

function armP2PTimeout() {
  clearTimeout(p2pTimer);
  if (callSettings().mode !== 'auto') return;
  p2pTimer = window.setTimeout(() => {
    if (pc && get().phase === 'connecting') switchToRelay();
  }, callSettings().p2pTimeoutSec * 1000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquireMedia(kind: CallKind, callId: string): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new CallError('Calls need a secure connection: open the app over https:// (or localhost).');
  }
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const video: MediaTrackConstraints = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };
  // In the APK the system permission dialog may still be open; keep retrying for a while.
  const deadline = Date.now() + (isNativeShell ? 25000 : 0);
  let asked = false;
  for (;;) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video: kind === 'video' ? video : false });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (kind === 'video' && (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError')) {
        // No usable camera: carry on with voice only.
        try {
          return await navigator.mediaDevices.getUserMedia({ audio });
        } catch {
          /* fall through */
        }
      }
      if (isNativeShell && Date.now() < deadline && get().callId === callId) {
        if (!asked) requestMediaPermission();
        asked = true;
        await sleep(1000);
        continue;
      }
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new CallError(`Allow microphone${kind === 'video' ? ' and camera' : ''} access to make calls.`);
      }
      if (name === 'NotFoundError') throw new CallError('No microphone found on this device.');
      throw new CallError("Couldn't start your microphone. Is another app using it?");
    }
  }
}

function markActive() {
  clearTimeout(failTimer);
  clearTimeout(p2pTimer);
  const s = get();
  if (s.phase === 'connecting') scheduleReports();
  if (s.phase === 'connecting' || s.phase === 'active') {
    set({ phase: 'active', status: '', startedAt: s.startedAt ?? Date.now() });
  }
}

async function restartIce() {
  if (!pc || get().direction !== 'outgoing' || restarts >= 2) return;
  restarts++;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    signal({ sdp: pc.localDescription });
  } catch (e) {
    console.warn('ice restart failed', e);
  }
}

async function createPeer(local: MediaStream): Promise<RTCPeerConnection> {
  const conn = new RTCPeerConnection({ iceServers: callSettings().iceServers });
  pc = conn;
  queuedCandidates = [];
  remoteTracks = [];
  restarts = 0;
  for (const t of local.getTracks()) conn.addTrack(t, local);

  conn.onicecandidate = (e) => {
    if (e.candidate) signal({ candidate: e.candidate.toJSON() });
  };
  conn.ontrack = (e) => {
    if (pc !== conn) return;
    remoteTracks = [...remoteTracks.filter((t) => t.kind !== e.track.kind), e.track];
    set({ remote: new MediaStream(remoteTracks) });
  };
  const onState = () => {
    if (pc !== conn) return;
    const st = conn.connectionState ?? conn.iceConnectionState;
    const ice = conn.iceConnectionState;
    if (st === 'connected' || ice === 'connected' || ice === 'completed') {
      markActive();
    } else if (st === 'disconnected' || ice === 'disconnected') {
      if (get().phase === 'active') set({ status: 'Reconnecting…' });
      clearTimeout(failTimer);
      failTimer = window.setTimeout(() => void restartIce(), 4000);
    } else if (st === 'failed' || ice === 'failed') {
      if (switchToRelay()) return;
      if (get().phase === 'active') set({ status: 'Reconnecting…' });
      void restartIce();
      clearTimeout(failTimer);
      failTimer = window.setTimeout(() => {
        const id = get().callId;
        if (pc === conn && id && conn.connectionState !== 'connected') {
          socket.send('call:end', { callId: id });
          finish(id, 'failed');
        }
      }, 15000);
    }
  };
  conn.onconnectionstatechange = onState;
  conn.oniceconnectionstatechange = onState;
  return conn;
}

function finish(callId: string, reason: string | null, opts: { silent?: boolean; text?: string } = {}) {
  const s = get();
  if (s.callId !== callId) return;
  clearTimeout(failTimer);
  clearTimeout(resumeTimer);
  clearTimeout(p2pTimer);
  reportTimers.forEach(clearTimeout);
  reportTimers = [];
  callAudio.stop();
  stopTones();
  pc?.close();
  pc = null;
  relay?.stop();
  relay = null;
  earlyChunks = [];
  queuedCandidates = [];
  s.local?.getTracks().forEach((t) => t.stop());
  historyListeners.forEach((fn) => fn());

  if (opts.silent || !reason) {
    releaseCallTones();
    set(idle, true);
    return;
  }
  playHangup();
  set({
    phase: 'ended',
    status: opts.text ?? END_TEXT[reason] ?? 'Call ended',
    local: null,
    remote: null,
    minimized: false,
  });
  clearTimeout(resetTimer);
  resetTimer = window.setTimeout(() => {
    if (get().callId === callId && get().phase === 'ended') set(idle, true);
  }, 1800);
}

// ---------- public actions ----------

export async function startCall(conversationId: number, peer: User, kind: CallKind) {
  const cur = get();
  if (cur.phase !== 'idle' && cur.phase !== 'ended') {
    toast("You're already in a call");
    return;
  }
  if (!socket.connected) {
    toast("You're offline. Check your connection.");
    return;
  }
  clearTimeout(resetTimer);
  const callId = uid();
  set({ ...idle, phase: 'outgoing', callId, kind, peer, conversationId, direction: 'outgoing', status: 'Calling…' }, true);
  try {
    const local = await acquireMedia(kind, callId);
    if (get().callId !== callId) {
      local.getTracks().forEach((t) => t.stop());
      return;
    }
    set({ local, cameraOff: kind === 'video' && local.getVideoTracks().length === 0 });
    startAudio(kind);
    if (!socket.send('call:invite', { callId, conversationId, kind })) finish(callId, 'offline');
  } catch (e) {
    finish(callId, 'failed', { text: e instanceof CallError ? e.message : 'Call failed' });
  }
}

export async function acceptCall() {
  const { callId, kind, phase } = get();
  if (!callId || phase !== 'incoming') return;
  stopTones();
  set({ phase: 'connecting', status: 'Connecting…' });
  try {
    const local = await acquireMedia(kind, callId);
    if (get().callId !== callId) {
      local.getTracks().forEach((t) => t.stop());
      return;
    }
    set({ local, cameraOff: kind === 'video' && local.getVideoTracks().length === 0 });
    startAudio(kind);
    if (wantsRelayOnly()) {
      socket.send('call:accept', { callId });
      startRelay();
    } else {
      await createPeer(local);
      socket.send('call:accept', { callId });
      armP2PTimeout();
    }
  } catch (e) {
    const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    socket.send('call:reject', { callId, reason: `could not start: ${why}` });
    finish(callId, 'failed', { text: e instanceof CallError ? e.message : 'Call failed' });
  }
}

export function declineCall() {
  const { callId } = get();
  if (!callId) return;
  socket.send('call:reject', { callId, reason: 'declined by user' });
  finish(callId, null, { silent: true });
}

export function hangUp() {
  const { callId, phase } = get();
  if (!callId) return;
  if (phase === 'ended') {
    set(idle, true);
    return;
  }
  socket.send('call:end', { callId });
  finish(callId, 'ended');
}

export function toggleMute() {
  const muted = !get().muted;
  get().local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  set({ muted });
  sendMediaState();
}

export function toggleCamera() {
  const { local } = get();
  if (!local?.getVideoTracks().length) {
    toast('No camera available');
    return;
  }
  const cameraOff = !get().cameraOff;
  local.getVideoTracks().forEach((t) => (t.enabled = !cameraOff));
  set({ cameraOff });
  sendMediaState();
}

export function toggleSpeaker() {
  const speaker = !get().speaker;
  callAudio.setSpeaker(speaker);
  relay?.setVolume(playbackVolume(speaker));
  set({ speaker });
}
export const setMinimized = (minimized: boolean) => set({ minimized });

export async function switchCamera() {
  const { local, facing, cameraOff } = get();
  const old = local?.getVideoTracks()[0];
  if ((!pc && !relay) || !local || !old) return;
  const next = facing === 'user' ? 'environment' : 'user';
  // Many phones can't open two cameras at once, so release the current one first.
  old.stop();
  let fresh: MediaStream;
  try {
    fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: next } } });
  } catch {
    try {
      fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
    } catch {
      toast("Couldn't switch camera");
      return;
    }
  }
  const track = fresh.getVideoTracks()[0];
  track.enabled = !cameraOff;
  local.removeTrack(old);
  local.addTrack(track);
  if (pc) {
    const sender = pc.getSenders().find((x) => x.track?.kind === 'video' || x.track === old);
    await sender?.replaceTrack(track);
  } else {
    relay?.startSending();
  }
  const switched = track.getSettings().facingMode;
  set({ facing: switched === 'environment' || (!switched && next === 'environment') ? 'environment' : 'user', local: new MediaStream(local.getTracks()) });
}

// ---------- call reports ----------
// A few seconds into each call, and again later, both sides send the server a
// one-line report (how media travels, whether the other side's audio arrives
// and plays) so "I can't hear them" can be traced from the server log.

function scheduleReports() {
  reportTimers.forEach(clearTimeout);
  reportTimers = [8, 45].map((sec) => window.setTimeout(() => void sendReport(`${sec}s`), sec * 1000));
}

function appKind() {
  if (isNativeShell) return callAudio.available() ? 'apk' : 'apk-unpatched';
  return window.matchMedia?.('(display-mode: standalone)').matches ? 'pwa' : 'web';
}

function device() {
  const ua = navigator.userAgent;
  const os = ua.match(/Android [\d.]+(; [^;)]+)?|iPhone OS [\d_]+|iPad; CPU OS [\d_]+|Windows NT [\d.]+|Mac OS X [\d_]+|Linux/)?.[0];
  const browser = ua.match(/(Edg|OPR|SamsungBrowser|CriOS|FxiOS|Firefox|Chrome|Version)\/\d+/)?.[0];
  return [os, browser].filter(Boolean).join(' ');
}

const playState = (el: HTMLMediaElement | null) =>
  el ? `${el.paused ? 'paused' : 'playing'}${el.muted ? ' muted' : ''} vol=${el.volume}${el.srcObject || el.src ? '' : ' empty'}` : 'none';

async function sendReport(at: string) {
  const s = get();
  if (!s.callId || s.phase !== 'active') return;
  const mic = s.local?.getAudioTracks()[0];
  const d: Record<string, unknown> = {
    callId: s.callId,
    at,
    kind: s.kind,
    dir: s.direction,
    app: appKind(),
    device: device(),
    route: s.audioRoute || undefined,
    native: callAudio.debug() || undefined,
    mic: mic ? `${mic.readyState}${mic.enabled ? '' : ' off'}${mic.muted ? ' muted' : ''}` : 'none',
  };
  if (relay) {
    const el = relay.element as HTMLVideoElement & { webkitAudioDecodedByteCount?: number };
    d.path = 'server';
    d.play = playState(el);
    d.heardBytes = el.webkitAudioDecodedByteCount;
  } else if (pc) {
    d.play = playState(document.querySelector('audio.remote-audio'));
    try {
      const stats = await pc.getStats();
      const byId = new Map<string, any>();
      let pairId = '';
      stats.forEach((r: any) => {
        byId.set(r.id, r);
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
        if (r.type === 'inbound-rtp' && r.kind === 'audio') d.heard = { bytes: r.bytesReceived, energy: Number((r.totalAudioEnergy ?? 0).toFixed(3)) };
        if (r.type === 'outbound-rtp' && r.kind === 'audio') d.sentBytes = r.bytesSent;
      });
      if (!pairId) stats.forEach((r: any) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && (pairId = r.id));
      const pair = byId.get(pairId);
      d.path = pair ? `${byId.get(pair.localCandidateId)?.candidateType}>${byId.get(pair.remoteCandidateId)?.candidateType}` : pc.connectionState;
    } catch {
      d.path = 'no-stats';
    }
  }
  socket.send('call:diag', d);
}

// ---------- signaling events ----------

socket.on('call:ringing', (d: { callId: string }) => {
  if (d.callId !== get().callId || get().phase !== 'outgoing') return;
  set({ status: 'Ringing…' });
  playRingback();
});

socket.on('call:incoming', (d: { callId: string; conversationId: number; kind: CallKind; from: User }) => {
  const cur = get();
  if (cur.phase !== 'idle' && cur.phase !== 'ended') {
    socket.send('call:reject', { callId: d.callId, reason: `busy here (${cur.phase})` });
    return;
  }
  clearTimeout(resetTimer);
  set(
    {
      ...idle,
      phase: 'incoming',
      callId: d.callId,
      kind: d.kind,
      direction: 'incoming',
      peer: d.from,
      conversationId: d.conversationId,
      status: d.kind === 'video' ? 'Incoming video call' : 'Incoming voice call',
    },
    true,
  );
  playRingtone();
  notify(d.from.name, d.kind === 'video' ? 'Incoming video call' : 'Incoming voice call');
});

socket.on('call:accepted', async (d: { callId: string }) => {
  const { callId, local } = get();
  if (d.callId !== callId || !local) return;
  stopTones();
  set({ phase: 'connecting', status: 'Connecting…' });
  if (wantsRelayOnly()) {
    startRelay();
    return;
  }
  try {
    const conn = await createPeer(local);
    const offer = await conn.createOffer();
    await conn.setLocalDescription(offer);
    signal({ sdp: conn.localDescription });
    sendMediaState();
    armP2PTimeout();
  } catch (e) {
    console.error(e);
    socket.send('call:end', { callId });
    finish(callId, 'failed');
  }
});

socket.on('call:signal', (d: { callId: string; payload: any }) => {
  if (d.callId !== get().callId) return;
  const payload = d.payload ?? {};
  // Apply signals strictly in arrival order.
  signalChain = signalChain.then(async () => {
    if (d.callId !== get().callId) return;
    if (payload.media) {
      set({ peerMuted: !!payload.media.muted, peerCameraOff: !!payload.media.cameraOff });
      return;
    }
    if (payload.relay) {
      if (!relay) startRelay();
      relay?.onSignal(payload.relay as RelaySignal);
      return;
    }
    const conn = pc;
    if (!conn) return;
    try {
      if (payload.sdp) {
        const desc = payload.sdp as RTCSessionDescriptionInit;
        await conn.setRemoteDescription(desc);
        for (const c of queuedCandidates.splice(0)) await conn.addIceCandidate(c).catch(() => {});
        if (desc.type === 'offer') {
          await conn.setLocalDescription(await conn.createAnswer());
          signal({ sdp: conn.localDescription });
          sendMediaState();
        }
      } else if (payload.candidate) {
        if (conn.remoteDescription) await conn.addIceCandidate(payload.candidate).catch(() => {});
        else queuedCandidates.push(payload.candidate);
      }
    } catch (e) {
      console.warn('signal', e);
    }
  });
});

socket.on('call:ended', (d: { callId: string; reason: string }) => {
  const s = get();
  if (d.callId !== s.callId) return;
  if (d.reason === 'answered_elsewhere' || (s.phase === 'incoming' && d.reason === 'rejected')) {
    finish(d.callId, null, { silent: true });
    return;
  }
  finish(d.callId, d.reason);
});

const mediaFlowing = () => !!relay || pc?.connectionState === 'connected';

// Losing the socket doesn't end an answered call: WebRTC media keeps flowing
// on its own, and the server keeps the call for a while so we can resume it.
socket.onStatus((connected) => {
  const { callId, phase } = get();
  if (connected || !callId || phase === 'idle' || phase === 'ended' || phase === 'incoming') return;
  if (phase === 'outgoing') {
    finish(callId, 'offline'); // the server ends a call whose caller left while ringing
    return;
  }
  if (relay || !mediaFlowing()) set({ status: 'Reconnecting…' });
  clearTimeout(resumeTimer);
  resumeTimer = window.setTimeout(() => {
    if (get().callId === callId && !socket.connected) finish(callId, 'offline');
  }, 35_000);
});

socket.on('hello', () => {
  const { callId, phase } = get();
  if (callId && (phase === 'connecting' || phase === 'active')) socket.send('call:resume', { callId });
});

socket.on('call:resumed', (d: { callId: string; peerConnected: boolean }) => {
  if (d.callId !== get().callId) return;
  clearTimeout(resumeTimer);
  if (relay) relay.startSending(); // chunks were lost while offline: start a fresh stream
  else if (pc && pc.connectionState !== 'connected') void restartIce();
  if (d.peerConnected && (relay || mediaFlowing())) set({ status: '' });
});

socket.on('call:peer-reconnecting', (d: { callId: string }) => {
  if (d.callId === get().callId && relay) set({ status: 'Reconnecting…' });
});

socket.on('call:peer-back', (d: { callId: string }) => {
  if (d.callId !== get().callId) return;
  if (relay) relay.startSending();
  if (relay || mediaFlowing()) set({ status: '' });
});
