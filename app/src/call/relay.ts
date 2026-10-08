// Fallback call transport for networks that block WebRTC: each side records
// its mic/camera with MediaRecorder (WebM/Opus/VP8) and streams the chunks
// over the app's own WebSocket; the other side plays them through
// MediaSource. Slower than WebRTC (~0.5 s) but it works wherever chatting works.
import { socket } from '../lib/socket';

const TIMESLICE = 120;

function pickMime(video: boolean): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaSource === 'undefined') return null;
  const options = video
    ? ['video/webm;codecs="vp8,opus"', 'video/webm;codecs="vp9,opus"', 'video/webm']
    : ['audio/webm;codecs="opus"', 'audio/webm'];
  return options.find((t) => MediaRecorder.isTypeSupported(t) && MediaSource.isTypeSupported(t)) ?? null;
}

export const relaySupported = (video: boolean) => pickMime(video) !== null || (video && pickMime(false) !== null);

export interface RelaySignal {
  start?: { gen: number; mime: string };
  reset?: boolean;
}

export class MediaRelay {
  readonly element: HTMLVideoElement;
  private recorder: MediaRecorder | null = null;
  private sendGen = 0;
  // receiving side
  private recvGen = -1;
  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private objectUrl = '';
  private queue: Uint8Array[] = [];
  private early = new Map<number, Uint8Array[]>(); // chunks that beat their start signal
  private gotData = false;
  private trimTimer: number;
  private resetAsked = 0;
  private stopped = false;

  constructor(
    private local: MediaStream,
    private video: boolean,
    private signal: (s: RelaySignal) => void,
    private onFirstData: () => void,
  ) {
    const el = document.createElement('video');
    el.playsInline = true;
    el.autoplay = true;
    el.className = 'call-video-full';
    el.onerror = () => this.askReset();
    this.element = el;
    this.trimTimer = window.setInterval(() => this.trim(), 10_000);
  }

  // ---------- sending ----------

  startSending() {
    if (this.stopped) return;
    this.recorder?.stop();
    const hasVideo = this.video && this.local.getVideoTracks().some((t) => t.readyState === 'live');
    const mime = pickMime(hasVideo);
    if (!mime) return;
    const tracks = this.local.getTracks().filter((t) => t.readyState === 'live' && (hasVideo || t.kind === 'audio'));
    const stream = new MediaStream(tracks);
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000, videoBitsPerSecond: 450_000 });
    } catch {
      return;
    }
    const gen = (this.sendGen = (this.sendGen + 1) % 256);
    this.signal({ start: { gen, mime } });
    rec.ondataavailable = async (e) => {
      if (!e.data.size || this.recorder !== rec) return;
      const body = new Uint8Array(await e.data.arrayBuffer());
      const frame = new Uint8Array(new ArrayBuffer(body.length + 1));
      frame[0] = gen;
      frame.set(body, 1);
      socket.sendBinary(frame);
    };
    rec.start(TIMESLICE);
    this.recorder = rec;
  }

  // ---------- receiving ----------

  onSignal(s: RelaySignal) {
    if (s.reset) this.startSending();
    if (s.start) this.openStream(s.start.gen, s.start.mime);
  }

  onChunk(buf: ArrayBuffer) {
    const bytes = new Uint8Array(buf);
    if (bytes.length < 2) return;
    const gen = bytes[0];
    const data = bytes.subarray(1);
    if (gen === this.recvGen) {
      this.queue.push(data);
      this.pump();
    } else {
      // Probably the start signal for a newer stream hasn't arrived yet.
      const list = this.early.get(gen) ?? [];
      if (list.length < 200) list.push(data);
      this.early.set(gen, list);
    }
  }

  private openStream(gen: number, mime: string) {
    if (!MediaSource.isTypeSupported(mime)) return;
    this.closeStream();
    this.recvGen = gen;
    this.queue = this.early.get(gen) ?? [];
    this.early.clear();
    const ms = new MediaSource();
    this.ms = ms;
    this.objectUrl = URL.createObjectURL(ms);
    this.element.src = this.objectUrl;
    ms.addEventListener('sourceopen', () => {
      if (this.ms !== ms) return;
      try {
        const sb = ms.addSourceBuffer(mime);
        sb.mode = 'sequence';
        sb.addEventListener('updateend', () => this.afterAppend());
        sb.addEventListener('error', () => this.askReset());
        this.sb = sb;
        this.pump();
      } catch {
        this.askReset();
      }
    });
  }

  private pump() {
    const sb = this.sb;
    if (!sb || sb.updating || !this.queue.length || this.ms?.readyState !== 'open') return;
    const next = this.queue.shift()!;
    try {
      sb.appendBuffer(next as BufferSource);
    } catch (e) {
      if ((e as DOMException).name === 'QuotaExceededError') {
        this.queue.unshift(next);
        this.trim(true);
      } else {
        this.askReset();
      }
    }
  }

  private afterAppend() {
    const el = this.element;
    if (!this.gotData) {
      this.gotData = true;
      this.onFirstData();
    }
    // Stay close to live: skip ahead if we've fallen behind.
    if (el.buffered.length) {
      const end = el.buffered.end(el.buffered.length - 1);
      if (end - el.currentTime > 1.0) el.currentTime = Math.max(0, end - 0.2);
    }
    if (el.paused) void el.play().catch(() => {});
    this.pump();
  }

  private trim(force = false) {
    const sb = this.sb;
    const el = this.element;
    if (!sb || sb.updating || !el.buffered.length) return;
    const keepFrom = el.currentTime - 8;
    if (keepFrom > el.buffered.start(0) + (force ? 0 : 10)) {
      try {
        sb.remove(el.buffered.start(0), keepFrom);
      } catch {
        /* ignore */
      }
    }
  }

  /** The stream broke (lost chunk, decoder error): ask the sender for a fresh one. */
  private askReset() {
    if (this.stopped || Date.now() - this.resetAsked < 1500) return;
    this.resetAsked = Date.now();
    this.closeStream();
    this.signal({ reset: true });
  }

  private closeStream() {
    this.sb = null;
    if (this.ms?.readyState === 'open') {
      try {
        this.ms.endOfStream();
      } catch {
        /* ignore */
      }
    }
    this.ms = null;
    this.queue = [];
    this.recvGen = -1;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = '';
  }

  setVolume(v: number) {
    this.element.volume = v;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.trimTimer);
    const rec = this.recorder;
    this.recorder = null;
    if (rec && rec.state !== 'inactive') rec.stop();
    this.closeStream();
    this.element.pause();
    this.element.removeAttribute('src');
    this.element.load();
  }
}
