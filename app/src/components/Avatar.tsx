import { Users } from 'lucide-react';
import { useState } from 'react';
import { mediaUrl } from '../lib/config';
import { initials } from '../lib/format';

const GRADIENTS = [
  ['#8b5cf6', '#ec4899'],
  ['#6366f1', '#22d3ee'],
  ['#a855f7', '#6366f1'],
  ['#f472b6', '#fb923c'],
  ['#14b8a6', '#6366f1'],
  ['#f59e0b', '#ef4444'],
  ['#3b82f6', '#8b5cf6'],
  ['#10b981', '#3b82f6'],
];

function hash(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) | 0;
  return Math.abs(h);
}

interface Props {
  name: string;
  src?: string;
  size?: number;
  online?: boolean;
  group?: boolean;
  ring?: boolean;
  className?: string;
}

export default function Avatar({ name, src, size = 52, online, group, ring = true, className = '' }: Props) {
  const [broken, setBroken] = useState(false);
  const [a, b] = GRADIENTS[hash(name || '?') % GRADIENTS.length];
  const showImage = src && !broken;
  return (
    <div
      className={`avatar ${ring ? 'avatar-ring' : ''} ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {showImage ? (
        <img src={mediaUrl(src)} alt="" onError={() => setBroken(true)} draggable={false} />
      ) : (
        <div className="avatar-fallback" style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}>
          {group ? <Users size={size * 0.42} strokeWidth={2.2} /> : initials(name)}
        </div>
      )}
      {online && <span className="avatar-dot" style={{ width: size * 0.26, height: size * 0.26 }} />}
    </div>
  );
}
