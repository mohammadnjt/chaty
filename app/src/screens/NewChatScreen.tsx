import { Check, ChevronLeft, Search, UserSearch, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import Avatar from '../components/Avatar';
import { api, errorText } from '../lib/api';
import { goBack, navigate } from '../lib/router';
import type { User } from '../lib/types';
import { addConversation } from '../store/chat';
import { useConfig } from '../store/config';
import { toast } from '../store/toast';

/**
 * Nobody can browse the user list: an empty search shows your contacts
 * (people you already chat with); anyone else is found only by their full
 * phone number or exact @ID.
 */
export function useUserSearch(q: string, enabled = true) {
  const [users, setUsers] = useState<User[] | null>(null);
  useEffect(() => {
    setUsers(null);
    if (!enabled) return;
    let alive = true;
    const t = setTimeout(
      () =>
        api
          .users(q.trim())
          .then((u) => alive && setUsers(u))
          .catch((e) => {
            if (alive) setUsers([]);
            toast(errorText(e));
          }),
      q ? 300 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, enabled]);
  return users;
}

function PageHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <header className="page-header">
      <button className="icon-btn" onClick={() => goBack('/')} aria-label="Back">
        <ChevronLeft size={26} />
      </button>
      <h2>{title}</h2>
      <div className="spacer" />
      {action}
    </header>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="search-wrap">
      <label className="search">
        <Search size={18} />
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Phone number or @ID"
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>
      <p className="search-hint">Enter someone's full phone number (0912…) or their exact @ID to find them.</p>
    </div>
  );
}

function sub(u: User) {
  return [u.role === 'admin' && 'Admin', u.username && `@${u.username}`, u.phone].filter(Boolean).join(' · ');
}

export function UserRow({ u, onClick, disabled }: { u: User; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="user-row" onClick={onClick} disabled={disabled}>
      <Avatar name={u.name} src={u.avatar} size={48} online={u.online} storyOf={u.id} />
      <div className="user-row-body">
        <span className="user-name" dir="auto">
          {u.name}
        </span>
        <span className="user-sub" dir="auto">
          {sub(u)}
        </span>
      </div>
    </button>
  );
}

function Results({
  q,
  users,
  render,
}: {
  q: string;
  users: User[] | null;
  render: (u: User) => React.ReactNode;
}) {
  if (users === null) return <>{Array.from({ length: 3 }, (_, i) => <div key={i} className="user-row skeleton" />)}</>;
  if (users.length === 0) {
    return (
      <div className="empty compact">
        <UserSearch size={36} strokeWidth={1.5} />
        <p>
          {q.trim()
            ? 'No one found. Check the number or ID — it has to match exactly.'
            : 'No contacts yet. Search for someone by phone number or @ID to start chatting.'}
        </p>
      </div>
    );
  }
  return (
    <>
      <h3 className="section-title">{q.trim() ? 'Results' : 'Your contacts'}</h3>
      {users.map(render)}
    </>
  );
}

export function NewChatScreen() {
  const groups = useConfig((s) => s.features.groups);
  const [q, setQ] = useState('');
  const users = useUserSearch(q);
  const [opening, setOpening] = useState(0);

  async function open(u: User) {
    setOpening(u.id);
    try {
      const c = await api.openDirect(u.id, q.trim());
      addConversation(c);
      navigate(`/chat/${c.id}`, { replace: true });
    } catch (e) {
      toast(errorText(e));
      setOpening(0);
    }
  }

  return (
    <div className="screen push">
      <PageHeader title="New chat" />
      <SearchField value={q} onChange={setQ} />
      <div className="scroll list">
        {groups && !q && (
          <button className="user-row" onClick={() => navigate('/new-group', { replace: true })}>
            <span className="round-icon">
              <Users size={22} />
            </span>
            <div className="user-row-body">
              <span className="user-name">New group</span>
              <span className="user-sub">Chat with several people at once</span>
            </div>
          </button>
        )}
        <Results
          q={q}
          users={users}
          render={(u) => <UserRow key={u.id} u={u} onClick={() => open(u)} disabled={!!opening} />}
        />
      </div>
    </div>
  );
}

export function NewGroupScreen() {
  const [q, setQ] = useState('');
  const users = useUserSearch(q);
  const [title, setTitle] = useState('');
  // picked user -> the search that found them (lets the server check you may add them)
  const [picked, setPicked] = useState<Map<number, { user: User; query: string }>>(new Map());
  const [busy, setBusy] = useState(false);

  function toggle(u: User) {
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(u.id)) next.delete(u.id);
      else next.set(u.id, { user: u, query: q.trim() });
      return next;
    });
  }

  async function create() {
    setBusy(true);
    try {
      const queries: Record<number, string> = {};
      for (const [id, p] of picked) if (p.query) queries[id] = p.query;
      const c = await api.createGroup(title.trim(), [...picked.keys()], queries);
      addConversation(c);
      navigate(`/chat/${c.id}`, { replace: true });
    } catch (e) {
      toast(errorText(e));
      setBusy(false);
    }
  }

  const ready = title.trim() && picked.size > 0 && !busy;

  return (
    <div className="screen push">
      <PageHeader
        title="New group"
        action={
          <button className="btn btn-primary small" disabled={!ready} onClick={create}>
            Create
          </button>
        }
      />
      <div className="group-form">
        <span className="round-icon big">
          <Users size={26} />
        </span>
        <input
          className="field"
          placeholder="Group name"
          value={title}
          maxLength={64}
          dir="auto"
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      {picked.size > 0 && (
        <div className="picked">
          {[...picked.values()].map(({ user: u }) => (
            <button key={u.id} className="picked-chip" onClick={() => toggle(u)}>
              <Avatar name={u.name} src={u.avatar} size={24} ring={false} />
              {u.name.split(' ')[0]} ✕
            </button>
          ))}
        </div>
      )}
      <SearchField value={q} onChange={setQ} />
      <div className="scroll list">
        <Results
          q={q}
          users={users}
          render={(u) => {
            const on = picked.has(u.id);
            return (
              <button key={u.id} className="user-row" onClick={() => toggle(u)}>
                <Avatar name={u.name} src={u.avatar} size={48} online={u.online} />
                <div className="user-row-body">
                  <span className="user-name" dir="auto">
                    {u.name}
                  </span>
                  <span className="user-sub" dir="auto">
                    {sub(u)}
                  </span>
                </div>
                <span className={`check ${on ? 'on' : ''}`}>{on && <Check size={16} strokeWidth={3} />}</span>
              </button>
            );
          }}
        />
      </div>
    </div>
  );
}

