import { Pause, Play } from 'lucide-react';
import { useMemo } from 'react';
import { formatDuration } from '../lib/format';
import type { Message } from '../lib/types';
import { playVoice, sameMessage, usePlayer } from '../store/player';

/** A voice message in a chat. It plays in the app-wide player, so it keeps going after you leave. */
export default function AudioMessage({ msg }: { msg: Message }) {
  const current = usePlayer((s) => sameMessage(s.msg, msg));
  const playing = usePlayer((s) => current && s.playing);
  const position = usePlayer((s) => (current ? s.position : 0));
  const total = usePlayer((s) => (current && s.duration ? s.duration : (msg.duration ?? 0)));
  const progress = total ? Math.min(1, position / total) : 0;
  const seed = msg.id || msg.createdAt;

  // A stable pseudo-waveform per message.
  const bars = useMemo(() => {
    let s = seed % 2147483646 || 1;
    return Array.from({ length: 28 }, () => {
      s = (s * 16807) % 2147483647;
      return 0.25 + (s / 2147483647) * 0.75;
    });
  }, [seed]);

  function seek(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    playVoice(msg, Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
  }

  return (
    <div className="audio-msg">
      <button className="audio-play" onClick={() => playVoice(msg)} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <div className="audio-wave" onPointerDown={seek}>
        {bars.map((h, i) => (
          <span key={i} className={i / bars.length < progress ? 'on' : ''} style={{ height: `${h * 100}%` }} />
        ))}
      </div>
      <span className="audio-time">{formatDuration(current ? position || total : total)}</span>
    </div>
  );
}
