import { Pause, Play, X } from 'lucide-react';
import { formatDuration } from '../lib/format';
import { navigate } from '../lib/router';
import { cycleRate, describeVoice, stopVoice, toggleVoice, usePlayer } from '../store/player';

/** The voice message playing, under the header (like Telegram's): pause, speed, close. */
export default function PlayerBar() {
  const msg = usePlayer((s) => s.msg);
  const playing = usePlayer((s) => s.playing);
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const rate = usePlayer((s) => s.rate);
  if (!msg) return null;
  const { title, text } = describeVoice(msg);
  return (
    <div className="player-bar">
      <button className="icon-btn" onClick={toggleVoice} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
      </button>
      <button className="player-info" onClick={() => navigate(`/chat/${msg.conversationId}`)}>
        <span className="player-title" dir="auto">
          {title}
        </span>
        <span className="player-sub">
          {formatDuration(position)}
          {duration ? ` / ${formatDuration(duration)}` : ''} · {text}
        </span>
      </button>
      <button className="player-rate" onClick={cycleRate} aria-label="Playback speed">
        {rate}×
      </button>
      <button className="icon-btn" onClick={stopVoice} aria-label="Close player">
        <X size={20} />
      </button>
      <span className="player-progress" style={{ width: `${duration ? Math.min(100, (position / duration) * 100) : 0}%` }} />
    </div>
  );
}
