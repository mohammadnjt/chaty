import { BellOff, CheckCheck, Check, CirclePlus, MessageSquare, Search } from 'lucide-react';
import { memo, useMemo, useRef, useState } from 'react';
import Avatar from '../components/Avatar';
import Logo from '../components/Logo';
import Scenery from '../components/Scenery';
import TabBar from '../components/TabBar';
import { api, errorText } from '../lib/api';
import { formatListTime } from '../lib/format';
import { navigate } from '../lib/router';
import type { Conversation, User } from '../lib/types';
import { activityOf, addConversation, peerOf, previewOf, titleOf, useChat } from '../store/chat';
import { toast } from '../store/toast';
import { UserRow, useUserSearch } from './NewChatScreen';

export function HeroHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="hero">
      <Scenery variant="header" className="hero-bg" />
      <div className="hero-row">
        <Logo size={34} />
        <h1>{title}</h1>
        <div className="spacer" />
        {children}
      </div>
    </header>
  );
}

const ChatRow = memo(function ChatRow({
  c,
  me,
  online,
  typing,
}: {
  c: Conversation;
  me: number;
  online: boolean;
  typing: boolean;
}) {
  const peer = c.type === 'direct' ? peerOf(c, me) : null;
  const title = titleOf(c, me);
  const last = c.lastMessage;
  const mine = last?.senderId === me;
  const read =
    mine && !!last?.id && Object.entries(c.reads).some(([uid, v]) => Number(uid) !== me && v >= last.id);
  const sender =
    last && c.type === 'group' && !mine ? c.members.find((m) => m.id === last.senderId)?.name.split(' ')[0] : null;

  return (
    <button className="chat-row" onClick={() => navigate(`/chat/${c.id}`)}>
      <Avatar name={title} src={peer ? peer.avatar : c.avatar} group={c.type === 'group'} online={online} />
      <div className="chat-row-body">
        <div className="chat-row-top">
          <span className="chat-name" dir="auto">
            {title}
            {c.muted && <BellOff size={14} className="muted-icon" />}
          </span>
          <span className={`chat-time ${c.unread ? 'accent' : ''}`}>{last ? formatListTime(last.createdAt) : ''}</span>
        </div>
        <div className="chat-row-bottom">
          <span className="chat-preview" dir="auto">
            {typing ? (
              <span className="typing-text">typing…</span>
            ) : (
              <>
                {mine && last?.id ? (
                  read ? (
                    <CheckCheck size={15} className="tick-read" />
                  ) : (
                    <Check size={15} />
                  )
                ) : null}
                {sender && <span className="preview-sender">{sender}: </span>}
                {last ? previewOf(last) : c.type === 'group' ? 'Group created' : ''}
              </>
            )}
          </span>
          {c.unread > 0 && <span className={`badge ${c.muted ? 'badge-muted' : ''}`}>{c.unread > 99 ? '99+' : c.unread}</span>}
        </div>
      </div>
    </button>
  );
});

export default function ChatsScreen() {
  const me = useChat((s) => s.me);
  const conversations = useChat((s) => s.conversations);
  const loaded = useChat((s) => s.loaded);
  const presence = useChat((s) => s.presence);
  const typing = useChat((s) => s.typing);
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const list = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => c.lastMessage || c.type === 'group')
        .sort((a, b) => activityOf(b) - activityOf(a)),
    [conversations],
  );
  const query = q.trim().toLowerCase();
  const shown = query
    ? list.filter(
        (c) =>
          titleOf(c, me).toLowerCase().includes(query) || previewOf(c.lastMessage).toLowerCase().includes(query),
      )
    : list;
  const now = Date.now();

  // Typing a phone number or @ID here also finds people, not just chats.
  const found = useUserSearch(q, !!query);
  const people = (found ?? []).filter((u) => !shown.some((c) => c.type === 'direct' && peerOf(c, me)?.id === u.id));
  const [opening, setOpening] = useState(0);

  async function openUser(u: User) {
    setOpening(u.id);
    try {
      const c = await api.openDirect(u.id, q.trim());
      addConversation(c);
      setQ('');
      navigate(`/chat/${c.id}`);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setOpening(0);
    }
  }

  return (
    <div className="screen tab-screen">
      <HeroHeader title="Chats">
        <button className="icon-btn hero-btn" onClick={() => searchRef.current?.focus()} aria-label="Search">
          <Search size={22} />
        </button>
        <button className="icon-btn hero-btn" onClick={() => navigate('/new')} aria-label="New chat">
          <CirclePlus size={25} />
        </button>
      </HeroHeader>

      <div className="search-wrap">
        <label className="search">
          <Search size={18} />
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats, phone or @ID" />
        </label>
      </div>

      <div className="scroll list">
        {!loaded && list.length === 0 ? (
          Array.from({ length: 6 }, (_, i) => <div key={i} className="chat-row skeleton" />)
        ) : shown.length === 0 && (!query || (found && people.length === 0)) ? (
          <div className="empty">
            <MessageSquare size={40} strokeWidth={1.5} />
            <p>
              {query
                ? 'No chats or people found. People are found by their full phone number or exact @ID.'
                : 'No chats yet. Start one with someone!'}
            </p>
            {!query && (
              <button className="btn btn-primary" onClick={() => navigate('/new')}>
                Start a chat
              </button>
            )}
          </div>
        ) : (
          shown.map((c) => {
            const peer = c.type === 'direct' ? peerOf(c, me) : null;
            const isTyping = Object.entries(typing[c.id] ?? {}).some(([uid, t]) => Number(uid) !== me && t.until > now);
            return (
              <ChatRow
                key={c.id}
                c={c}
                me={me}
                online={!!peer && !!presence[peer.id]?.online}
                typing={isTyping}
              />
            );
          })
        )}
        {query && people.length > 0 && (
          <>
            <h3 className="section-title">People</h3>
            {people.map((u) => (
              <UserRow key={u.id} u={u} onClick={() => void openUser(u)} disabled={!!opening} />
            ))}
          </>
        )}
        <div className="list-spacer" />
      </div>

      <Scenery variant="footer" className="footer-scene" />
      <TabBar active="/" />
    </div>
  );
}
