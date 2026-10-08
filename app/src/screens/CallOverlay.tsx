import {
  Bluetooth,
  ChevronLeft,
  Headphones,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  SwitchCamera,
  Video,
  VideoOff,
  Volume1,
  Volume2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  acceptCall,
  declineCall,
  hangUp,
  playbackVolume,
  relayElement,
  setMinimized,
  switchCamera,
  toggleCamera,
  toggleMute,
  toggleSpeaker,
  useCall,
} from '../call/engine';
import Avatar from '../components/Avatar';
import Scenery from '../components/Scenery';
import { formatDuration } from '../lib/format';
import { callAudio } from '../lib/native';

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function StreamVideo({ stream, mirror, className }: { stream: MediaStream; mirror?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const track = stream.getVideoTracks()[0];
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Picture only: the sound plays once, through <RemoteAudio>.
    el.srcObject = track ? new MediaStream([track]) : null;
    void el.play().catch(() => {});
  }, [track]);
  return <video ref={ref} className={`${className ?? ''} ${mirror ? 'mirror' : ''}`} autoPlay playsInline muted />;
}

/** In relay mode the engine owns the <video> fed by MediaSource; mount it here. */
function RelayVideo() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = relayElement();
    if (!el || !host.current) return;
    host.current.appendChild(el);
    void el.play().catch(() => {});
    return () => {
      el.remove();
      // Removing a media element pauses it; resume so audio continues while minimized.
      setTimeout(() => void el.play().catch(() => {}), 60);
    };
  }, []);
  return <div ref={host} className="relay-host" />;
}

/** Remote audio lives outside the call UI so it keeps playing while minimized. */
export function RemoteAudio() {
  // The audio track alone, and the same stream for the whole call: the video
  // track arriving later doesn't restart playback.
  const track = useCall((s) => s.remote?.getAudioTracks()[0] ?? null);
  const speaker = useCall((s) => s.speaker);
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = track ? new MediaStream([track]) : null;
    if (!track) return;
    const play = () => {
      if (el.paused) void el.play().catch(() => {});
    };
    play();
    // If the browser held playback back, the next tap starts it.
    document.addEventListener('pointerdown', play);
    return () => document.removeEventListener('pointerdown', play);
  }, [track]);
  useEffect(() => {
    if (ref.current) ref.current.volume = playbackVolume(speaker);
  }, [speaker]);
  return <audio ref={ref} className="remote-audio" autoPlay playsInline hidden />;
}

/** Speaker on/off; in the Android app it also shows when earphones are in use. */
function SpeakerButton() {
  const speaker = useCall((s) => s.speaker);
  const route = useCall((s) => s.audioRoute);
  const [label, icon] =
    route === 'bluetooth'
      ? ['Bluetooth', <Bluetooth size={26} />]
      : route === 'wired'
        ? ['Headset', <Headphones size={26} />]
        : ['Speaker', speaker ? <Volume2 size={26} /> : <Volume1 size={26} />];
  return (
    <CallButton label={label} on={route ? route === 'speaker' : speaker} onClick={toggleSpeaker}>
      {icon}
    </CallButton>
  );
}

/** Live level bars driven by whoever is talking. */
function Waveform({ streams }: { streams: (MediaStream | null)[] }) {
  const bars = useRef<HTMLSpanElement[]>([]);
  const COUNT = 31;

  useEffect(() => {
    let ctx: AudioContext | null = null;
    const analysers: AnalyserNode[] = [];
    try {
      ctx = new AudioContext();
      for (const s of streams) {
        if (!s?.getAudioTracks().length) continue;
        const src = ctx.createMediaStreamSource(s);
        const a = ctx.createAnalyser();
        a.fftSize = 256;
        a.smoothingTimeConstant = 0.75;
        src.connect(a);
        analysers.push(a);
      }
    } catch {
      /* no WebAudio: idle animation only */
    }
    const data = new Uint8Array(128);
    let raf = 0;
    const draw = (t: number) => {
      let level = 0;
      for (const a of analysers) {
        a.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 2; i < 48; i++) sum += data[i];
        level = Math.max(level, sum / (46 * 255));
      }
      const mid = (COUNT - 1) / 2;
      bars.current.forEach((el, i) => {
        if (!el) return;
        const d = Math.abs(i - mid) / mid;
        const idle = 0.12 + 0.06 * Math.sin(t / 380 + i * 0.7);
        const wave = Math.abs(Math.sin(t / 140 + i * 1.3)) * 0.5 + 0.5;
        const h = Math.max(idle, Math.min(1, level * 2.6 * wave * (1 - d * 0.65)));
        el.style.transform = `scaleY(${h})`;
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      void ctx?.close();
    };
  }, [streams[0], streams[1]]);

  return (
    <div className="waveform" aria-hidden="true">
      {Array.from({ length: COUNT }, (_, i) => (
        <span key={i} ref={(el) => void (bars.current[i] = el!)} />
      ))}
    </div>
  );
}

function CallButton({
  onClick,
  label,
  variant = 'dark',
  on,
  children,
}: {
  onClick: () => void;
  label?: string;
  variant?: 'dark' | 'end' | 'accept';
  on?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="call-btn-wrap">
      <button className={`call-btn ${variant} ${on ? 'on' : ''}`} onClick={onClick} aria-label={label}>
        {children}
      </button>
      {label && <span>{label}</span>}
    </div>
  );
}

function CallPill() {
  const s = useCall();
  const now = useNow(true);
  return (
    <button className="call-pill" onClick={() => setMinimized(false)}>
      <span className="call-pill-dot" />
      <span className="call-pill-name">{s.peer?.name}</span>
      <span>{s.phase === 'active' && s.startedAt ? formatDuration(now - s.startedAt) : s.status}</span>
      <span className="call-pill-hint">Tap to return</span>
    </button>
  );
}

export default function CallOverlay() {
  const s = useCall();
  const now = useNow(s.phase === 'active');

  if (s.phase === 'idle' || !s.peer) return null;
  if (s.minimized && s.phase !== 'incoming' && s.phase !== 'ended') return <CallPill />;

  const isVideo = s.kind === 'video';
  const relayVideo = s.relay && isVideo && !s.peerCameraOff && s.phase === 'active';
  const remoteVideo = relayVideo || (s.remote?.getVideoTracks().length && !s.peerCameraOff && s.phase === 'active');
  const localVideo = s.local?.getVideoTracks().length && !s.cameraOff;
  const fullLocal = isVideo && localVideo && !remoteVideo && s.phase !== 'ended';
  const timer = s.phase === 'active' && s.startedAt ? formatDuration(now - s.startedAt) : '';
  const subtitle =
    s.phase === 'active'
      ? s.status || timer
      : s.phase === 'incoming'
        ? s.status
        : s.status || (isVideo ? 'Video call…' : 'Voice call…');
  const canMinimize = s.phase !== 'incoming' && s.phase !== 'ended';

  return (
    <div className={`call-screen ${remoteVideo || fullLocal ? 'has-video' : ''}`}>
      {relayVideo ? (
        <RelayVideo />
      ) : remoteVideo ? (
        <StreamVideo stream={s.remote!} className="call-video-full" />
      ) : fullLocal ? (
        <StreamVideo stream={s.local!} mirror={s.facing === 'user'} className="call-video-full" />
      ) : (
        <>
          <Scenery variant="full" className="call-bg" />
          <div className="call-bg-shade" />
        </>
      )}

      <header className="call-top">
        {canMinimize ? (
          <button className="icon-btn" onClick={() => setMinimized(true)} aria-label="Minimize call">
            <ChevronLeft size={26} />
          </button>
        ) : (
          <span className="icon-btn-space" />
        )}
        <Avatar name={s.peer.name} src={s.peer.avatar} size={42} />
        <div className="call-top-text">
          <span className="call-top-name" dir="auto">
            {s.peer.name}
          </span>
          <span className="call-top-sub">
            {isVideo ? 'Video call' : 'Voice call'}
            {timer ? ` · ${timer}` : '...'}
            {s.relay && s.phase !== 'ended' && <span className="relay-badge">via server</span>}
          </span>
        </div>
        <div className="spacer" />
        {isVideo && localVideo && s.phase !== 'ended' && s.phase !== 'incoming' ? (
          <button className="icon-btn" onClick={() => void switchCamera()} aria-label="Switch camera">
            <SwitchCamera size={22} />
          </button>
        ) : null}
      </header>

      {remoteVideo && localVideo ? (
        <StreamVideo stream={s.local!} mirror={s.facing === 'user'} className="call-pip" />
      ) : null}

      {!remoteVideo && !fullLocal && (
        <div className="call-center">
          <div className={`call-avatar ${s.phase === 'active' ? 'live' : 'ringing'}`}>
            <Avatar name={s.peer.name} src={s.peer.avatar} size={148} ring={false} />
          </div>
          <h2 dir="auto">{s.peer.name}</h2>
          <p className="call-status">{subtitle}</p>
          {s.phase !== 'ended' && s.phase !== 'incoming' && <Waveform streams={[s.remote, s.local]} />}
          {s.phase === 'active' && s.peerMuted && <p className="call-note">{s.peer.name.split(' ')[0]} is muted</p>}
        </div>
      )}

      {(remoteVideo || fullLocal) && (
        <div className="call-video-status">
          {s.phase !== 'active' && <p className="call-status">{subtitle}</p>}
          {s.phase === 'active' && s.peerMuted && <p className="call-note">{s.peer.name.split(' ')[0]} is muted</p>}
        </div>
      )}

      <div className="call-controls">
        {s.phase === 'incoming' ? (
          <>
            <CallButton variant="end" label="Decline" onClick={declineCall}>
              <PhoneOff size={28} />
            </CallButton>
            <CallButton variant="accept" label="Accept" onClick={() => void acceptCall()}>
              {isVideo ? <Video size={28} /> : <Phone size={28} />}
            </CallButton>
          </>
        ) : (
          <>
            <CallButton label={s.muted ? 'Unmute' : 'Mute'} on={s.muted} onClick={toggleMute}>
              {s.muted ? <MicOff size={26} /> : <Mic size={26} />}
            </CallButton>
            <CallButton variant="end" label="End" onClick={hangUp}>
              <PhoneOff size={30} />
            </CallButton>
            {isVideo ? (
              <>
                <CallButton label={s.cameraOff ? 'Camera on' : 'Camera off'} on={s.cameraOff} onClick={toggleCamera}>
                  {s.cameraOff ? <VideoOff size={26} /> : <Video size={26} />}
                </CallButton>
                {callAudio.available() && <SpeakerButton />}
              </>
            ) : (
              <SpeakerButton />
            )}
          </>
        )}
      </div>
    </div>
  );
}
