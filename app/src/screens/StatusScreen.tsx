import { Pencil, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import Avatar from '../components/Avatar';
import StoryComposer from '../components/StoryComposer';
import StoryViewer from '../components/StoryViewer';
import TabBar from '../components/TabBar';
import { api, errorText } from '../lib/api';
import { formatAgo, formatLastSeen } from '../lib/format';
import { navigate } from '../lib/router';
import type { User } from '../lib/types';
import { updateProfile, useAuth } from '../store/auth';
import { addConversation, useChat } from '../store/chat';
import { useConfig } from '../store/config';
import { loadStories, useStories } from '../store/stories';
import { toast } from '../store/toast';
import { HeroHeader } from './ChatsScreen';

const lastAt = (list: { createdAt: number }[]) => list[list.length - 1]?.createdAt ?? 0;

/** Photo and video stories: yours first, then the people you chat with. */
function Stories() {
  const me = useAuth((s) => s.me)!;
  const { mine, feed } = useStories();
  const [viewing, setViewing] = useState<{ mine: boolean; start: number } | null>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => void loadStories(), []);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!/^(image|video)\//.test(f.type)) {
      toast('Choose a photo or a video');
      return;
    }
    setPicked(f);
  }

  const add = () => fileRef.current?.click();

  return (
    <>
      <h3 className="section-title">Stories</h3>
      <div className="card story-list">
        <div className="story-row">
          <button className="story-open" onClick={() => (mine.length ? setViewing({ mine: true, start: 0 }) : add())}>
            <span className={`story-ring ${mine.length ? 'seen' : 'empty'}`}>
              <Avatar name={me.name} src={me.avatar} size={52} ring={false} />
            </span>
            <span className="user-row-body">
              <span className="user-name">My story</span>
              <span className="user-sub">
                {mine.length
                  ? `${mine.length} ${mine.length === 1 ? 'update' : 'updates'} · ${formatAgo(lastAt(mine))}`
                  : 'Share a photo or video for 24 hours'}
              </span>
            </span>
          </button>
          <button className="icon-btn accent" onClick={add} aria-label="Add a story">
            <Plus size={22} />
          </button>
        </div>
        {feed.map((g, i) => (
          <button key={g.user.id} className="story-row story-open" onClick={() => setViewing({ mine: false, start: i })}>
            <span className={`story-ring ${g.unseen ? '' : 'seen'}`}>
              <Avatar name={g.user.name} src={g.user.avatar} size={52} ring={false} />
            </span>
            <span className="user-row-body">
              <span className="user-name" dir="auto">
                {g.user.name}
              </span>
              <span className="user-sub">{formatAgo(lastAt(g.stories))}</span>
            </span>
          </button>
        ))}
        <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={onPick} />
      </div>
      {viewing && (
        <StoryViewer
          groups={viewing.mine ? [{ user: me, stories: mine }] : feed}
          start={viewing.start}
          mine={viewing.mine}
          onClose={() => setViewing(null)}
        />
      )}
      {picked && <StoryComposer file={picked} onClose={() => setPicked(null)} />}
    </>
  );
}

const PRESETS = ['Available', 'Busy', 'At work', 'In a meeting', 'Out for coffee ☕', 'Sleeping 😴', 'Only urgent calls'];

export default function StatusScreen() {
  const me = useAuth((s) => s.me)!;
  const conversations = useChat((s) => s.conversations);
  const presence = useChat((s) => s.presence);
  const storiesOn = useConfig((s) => s.features.stories);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(me.about);
  const [saving, setSaving] = useState(false);

  const contacts = useMemo(() => {
    const map = new Map<number, User>();
    for (const c of Object.values(conversations)) for (const m of c.members) if (m.id !== me.id) map.set(m.id, m);
    return [...map.values()];
  }, [conversations, me.id]);

  const sorted = [...contacts].sort((a, b) => {
    const oa = presence[a.id]?.online ? 1 : 0;
    const ob = presence[b.id]?.online ? 1 : 0;
    return ob - oa || a.name.localeCompare(b.name);
  });

  async function save(about: string) {
    setSaving(true);
    try {
      await updateProfile({ about });
      setEditing(false);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  async function openChat(u: User) {
    try {
      const c = await api.openDirect(u.id);
      addConversation(c);
      navigate(`/chat/${c.id}`);
    } catch (e) {
      toast(errorText(e));
    }
  }

  return (
    <div className="screen tab-screen">
      <HeroHeader title="Status" />
      <div className="scroll list list-top">
        {storiesOn && <Stories />}
        {storiesOn && <h3 className="section-title">Text status</h3>}
        <div className="card status-card">
          <div className="status-me">
            <Avatar name={me.name} src={me.avatar} size={58} online />
            <div className="status-me-text">
              <span className="user-name">My status</span>
              {!editing && (
                <span className="status-about" dir="auto">
                  {me.about || 'Set a status so friends know what you are up to'}
                </span>
              )}
            </div>
            {!editing && (
              <button
                className="icon-btn accent"
                onClick={() => {
                  setDraft(me.about);
                  setEditing(true);
                }}
                aria-label="Edit status"
              >
                <Pencil size={19} />
              </button>
            )}
          </div>
          {editing && (
            <div className="status-edit">
              <input
                className="field"
                value={draft}
                maxLength={140}
                dir="auto"
                autoFocus
                placeholder="What's on your mind?"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && save(draft)}
              />
              <div className="chips">
                {PRESETS.map((p) => (
                  <button key={p} className={`chip ${draft === p ? 'on' : ''}`} onClick={() => setDraft(p)}>
                    {p}
                  </button>
                ))}
              </div>
              <div className="row-end">
                <button className="btn btn-ghost" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" disabled={saving} onClick={() => save(draft)}>
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        <h3 className="section-title">Contacts</h3>
        {sorted.length === 0 ? (
          <p className="muted pad">People you chat with will show up here.</p>
        ) : (
          sorted.map((u) => {
            const p = presence[u.id];
            return (
              <button key={u.id} className="user-row" onClick={() => openChat(u)}>
                <Avatar name={u.name} src={u.avatar} size={48} online={!!p?.online} storyOf={u.id} />
                <div className="user-row-body">
                  <span className="user-name" dir="auto">
                    {u.name}
                  </span>
                  <span className="user-sub" dir="auto">
                    {u.about || '—'}
                  </span>
                </div>
                <span className={`presence ${p?.online ? 'on' : ''}`}>
                  {p?.online ? 'online' : formatLastSeen(p?.lastSeen ?? u.lastSeen).replace('last seen ', '')}
                </span>
              </button>
            );
          })
        )}
        <div className="list-spacer" />
      </div>
      <TabBar active="/status" />
    </div>
  );
}
