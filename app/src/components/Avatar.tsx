import { Users } from 'lucide-react';
import { useState } from 'react';
import { mediaUrl } from '../lib/config';
import { useStoryState, watchStories } from '../store/stories';
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
  /** This person's user id: a ring shows when they have a story, and tapping the photo plays it. */
  storyOf?: number;
}

export default function Avatar({ name, src, size = 52, online, group, ring = true, className = '', storyOf }: Props) {
  const [broken, setBroken] = useState(false);
  const story = useStoryState(storyOf);
  const [a, b] = GRADIENTS[hash(name || '?') % GRADIENTS.length];
  const showImage = src && !broken;
  const watch = (e: React.SyntheticEvent) => {
    // Not the chat row or header the photo sits in.
    e.stopPropagation();
    e.preventDefault();
    watchStories(storyOf!);
  };
  return (
    <div
      className={`avatar ${ring ? 'avatar-ring' : ''} ${story ? `has-story story-${story}` : ''} ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      {...(story && {
        role: 'button',
        tabIndex: 0,
        'aria-label': `${name}'s story`,
        onClick: watch,
        onKeyDown: (e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && watch(e),
      })}
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
