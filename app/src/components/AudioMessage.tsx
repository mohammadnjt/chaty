import { Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDuration } from '../lib/format';

let playing: HTMLAudioElement | null = null;

export default function AudioMessage({ src, duration = 0, seed }: { src: string; duration?: number; seed: number }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(duration);

  // A stable pseudo-waveform per message.
  const bars = useMemo(() => {
    let s = seed % 2147483646 || 1;
    return Array.from({ length: 28 }, () => {
      s = (s * 16807) % 2147483647;
      return 0.25 + (s / 2147483647) * 0.75;
    });
  }, [seed]);

  useEffect(() => () => audio.current?.pause(), []);

  function toggle() {
    let el = audio.current;
    if (!el) {
      el = new Audio(src);
      el.preload = 'auto';
      el.ontimeupdate = () => {
        const d = isFinite(el!.duration) ? el!.duration * 1000 : total;
        if (d) setProgress((el!.currentTime * 1000) / d);
      };
      el.onloadedmetadata = () => {
        if (isFinite(el!.duration)) setTotal(el!.duration * 1000);
      };
      el.onended = () => {
        setPlaying(false);
        setProgress(0);
      };
      el.onpause = () => setPlaying(false);
      el.onplay = () => setPlaying(true);
      audio.current = el;
    }
    if (el.paused) {
      if (playing && playing !== el) playing.pause();
      playing = el;
      void el.play().catch(() => setPlaying(false));
    } else el.pause();
  }

  function seek(e: React.PointerEvent<HTMLDivElement>) {
    const el = audio.current;
    if (!el || !isFinite(el.duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = p * el.duration;
    setProgress(p);
  }

  return (
    <div className="audio-msg">
      <button className="audio-play" onClick={toggle} aria-label={isPlaying ? 'Pause' : 'Play'}>
        {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <div className="audio-wave" onPointerDown={seek}>
        {bars.map((h, i) => (
          <span key={i} className={i / bars.length < progress ? 'on' : ''} style={{ height: `${h * 100}%` }} />
        ))}
      </div>
      <span className="audio-time">{formatDuration(isPlaying || progress > 0 ? progress * total : total)}</span>
    </div>
  );
}
