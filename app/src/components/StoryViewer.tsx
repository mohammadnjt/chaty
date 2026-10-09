import { Eye, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, errorText } from '../lib/api';
import { mediaUrl } from '../lib/config';
import { formatAgo } from '../lib/format';
import type { Story, StoryViewer as Viewer, User } from '../lib/types';
import { loadStories, markStorySeen, stopWatching, useStories } from '../store/stories';
import { toast } from '../store/toast';
import Avatar from './Avatar';

const PHOTO_MS = 5000;

interface Group {
  user: User;
  stories: Story[];
}

const firstUnseen = (g?: Group) => Math.max(0, g?.stories.findIndex((s) => !s.seen) ?? 0);

/**
 * Full-screen stories, Instagram style: tap right for next, left for back,
 * hold to pause. Your own stories show who viewed them and can be deleted.
 */
export default function StoryViewer({
  groups: initial,
  start,
  mine,
  onClose,
}: {
  groups: Group[];
  start: number;
  mine?: boolean;
  onClose: () => void;
}) {
  // The list as it was when opened, so new stories arriving don't move things around.
  const [groups, setGroups] = useState(initial);
  const [gi, setGi] = useState(start);
  const [si, setSi] = useState(() => (mine ? 0 : firstUnseen(initial[start])));
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [ready, setReady] = useState(false);
  const [viewers, setViewers] = useState<Viewer[] | null>(null);
  const elapsed = useRef(0);
  const video = useRef<HTMLVideoElement>(null);
  const press = useRef<{ at: number; x: number } | null>(null);

  const group = groups[gi];
  const story = group?.stories[si];
  const hold = paused || viewers !== null;

  const next = useCallback(() => {
    if (si + 1 < group.stories.length) setSi(si + 1);
    else if (gi + 1 < groups.length) {
      setGi(gi + 1);
      setSi(mine ? 0 : firstUnseen(groups[gi + 1]));
    } else onClose();
  }, [si, gi, group, groups, mine, onClose]);

  const prev = useCallback(() => {
    if (si > 0) setSi(si - 1);
    else if (gi > 0) {
      setGi(gi - 1);
      setSi(groups[gi - 1].stories.length - 1);
    } else {
      elapsed.current = 0;
      setProgress(0);
      if (video.current) video.current.currentTime = 0;
    }
  }, [si, gi, groups]);

  useEffect(() => {
    if (!story) onClose();
  }, [story, onClose]);

  // A new story: start from zero and count it as seen.
  useEffect(() => {
    elapsed.current = 0;
    setProgress(0);
    setReady(false);
    if (story && !mine) markStorySeen(story);
  }, [story?.id]);

  // Photos run on a timer once loaded; videos report their own progress.
  useEffect(() => {
    if (!story || story.type !== 'image' || !ready || hold) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      elapsed.current += now - last;
      last = now;
      const p = Math.min(1, elapsed.current / PHOTO_MS);
      setProgress(p);
      if (p >= 1) next();
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [story, ready, hold, next]);

  useEffect(() => {
    const v = video.current;
    if (!v || story?.type !== 'video') return;
    if (hold) v.pause();
    else
      void v.play().catch(() => {
        // No sound allowed without a tap: play muted rather than not at all.
        v.muted = true;
        void v.play().catch(() => {});
      });
  }, [story, hold]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, onClose]);

  if (!story) return null;

  function onDown(e: React.PointerEvent) {
    press.current = { at: Date.now(), x: e.clientX };
    setPaused(true);
  }

  function onUp(e: React.PointerEvent) {
    const p = press.current;
    press.current = null;
    setPaused(false);
    if (!p || Date.now() - p.at > 300) return; // that was a hold
    const box = e.currentTarget.getBoundingClientRect();
    if (p.x - box.left < box.width / 3) prev();
    else next();
  }

  async function showViewers() {
    try {
      setViewers(await api.storyViews(story.id));
    } catch (e) {
      toast(errorText(e));
    }
  }

  async function remove() {
    if (!window.confirm('Delete this story?')) return;
    try {
      await api.deleteStory(story.id);
      void loadStories();
      const left = group.stories.filter((s) => s.id !== story.id);
      if (!left.length) {
        onClose();
        return;
      }
      setGroups(groups.map((g, i) => (i === gi ? { ...g, stories: left } : g)));
      setSi(Math.min(si, left.length - 1));
    } catch (e) {
      toast(errorText(e));
    }
  }

  // Over the whole app, not just the screen it was opened from.
  return createPortal(
    <div className="story-screen">
      {story.type === 'video' ? (
        <video
          key={story.id}
          ref={video}
          src={mediaUrl(story.url)}
          className="story-media"
          autoPlay
          playsInline
          onPlaying={() => setReady(true)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            if (v.duration) setProgress(v.currentTime / v.duration);
          }}
          onEnded={next}
          onError={() => toast("This video can't be played here")}
        />
      ) : (
        <img
          key={story.id}
          src={mediaUrl(story.url)}
          className="story-media"
          alt=""
          onLoad={() => setReady(true)}
          onError={() => setReady(true)}
        />
      )}
      {!ready && <div className="story-loading" />}

      <div
        className="story-tap"
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={() => setPaused(false)}
        onContextMenu={(e) => e.preventDefault()}
      />

      <header className="story-top">
        <div className="story-bars">
          {group.stories.map((s, i) => (
            <span key={s.id} className="story-bar">
              <span style={{ width: i < si ? '100%' : i === si ? `${progress * 100}%` : '0%' }} />
            </span>
          ))}
        </div>
        <div className="story-head">
          <Avatar name={group.user.name} src={group.user.avatar} size={36} ring={false} />
          <div className="story-head-text">
            <span className="story-head-title" dir="auto">
              {mine ? 'My story' : group.user.name}
            </span>
            <span className="story-head-sub">{formatAgo(story.createdAt)}</span>
          </div>
          <div className="spacer" />
          {mine && (
            <button className="icon-btn" onClick={() => void remove()} aria-label="Delete story">
              <Trash2 size={21} />
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={24} />
          </button>
        </div>
      </header>

      {(story.caption || mine) && (
        <div className="story-bottom">
          {story.caption && (
            <p className="story-caption" dir="auto">
              {story.caption}
            </p>
          )}
          {mine && (
            <button className="story-views" onClick={() => void showViewers()}>
              <Eye size={18} /> {story.views ?? 0} {story.views === 1 ? 'view' : 'views'}
            </button>
          )}
        </div>
      )}

      {viewers && (
        <div className="sheet-backdrop" onClick={() => setViewers(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-head">
              <h3>Viewed by {viewers.length}</h3>
              <button className="icon-btn" onClick={() => setViewers(null)} aria-label="Close">
                <X size={22} />
              </button>
            </div>
            <div className="sheet-list">
              {viewers.length === 0 && <p className="muted small story-noviews">No one has seen it yet.</p>}
              {viewers.map((v) => (
                <div key={v.user.id} className="user-row">
                  <Avatar name={v.user.name} src={v.user.avatar} size={44} />
                  <div className="user-row-body">
                    <span className="user-name" dir="auto">
                      {v.user.name}
                    </span>
                    <span className="user-sub">{formatAgo(v.at)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>,
    document.querySelector('.app') ?? document.body,
  );
}

/** Stories opened from someone's avatar, anywhere in the app. */
export function StoryHost() {
  const watching = useStories((s) => s.watching);
  const group = useStories((s) => s.feed.find((g) => g.user.id === watching));
  if (watching == null || !group) return null;
  return <StoryViewer key={watching} groups={[group]} start={0} onClose={stopWatching} />;
}

