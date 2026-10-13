import { Ban, Bell, BellOff, ChevronDown, ChevronLeft, EllipsisVertical, LogOut, Paperclip, Phone, Pin, Trash2, Video, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { startCall } from '../call/engine';
import { joinGroupCall, useGroupCall } from '../call/group';
import Avatar from '../components/Avatar';
import Composer from '../components/Composer';
import MessageBubble from '../components/MessageBubble';
import MessageMenu from '../components/MessageMenu';
import PlayerBar from '../components/PlayerBar';
import Scenery from '../components/Scenery';
import { AttachSheet, ForwardSheet, type Pick } from '../components/Sheets';
import { api, errorText } from '../lib/api';
import { formatDay, formatLastSeen, sameDay } from '../lib/format';
import { fileNameFor, shrinkImage } from '../lib/media';
import { goBack } from '../lib/router';
import type { Conversation, Message, User } from '../lib/types';
import { appVisible, onAppVisibility } from '../lib/visibility';
import { useAuth } from '../store/auth';
import {
  deleteMessage,
  ensureConversation,
  isGroupAdmin,
  loadMessages,
  loadOlder,
  markRead,
  nameOf,
  peerOf,
  pinMessage,
  previewOf,
  reactTo,
  removeConversation,
  retryMessage,
  sendMessage,
  setBlocked,
  setForwardDraft,
  setMuted,
  titleOf,
  useChat,
} from '../store/chat';
import { useConfig } from '../store/config';
import { toast } from '../store/toast';
import { GroupAdminMenu, GroupHero, GroupMembers } from './GroupInfo';

const NAME_COLORS = ['#c4b5fd', '#f9a8d4', '#93c5fd', '#fcd34d', '#86efac', '#fdba74', '#a5f3fc', '#f0abfc'];
const nameColor = (id: number) => NAME_COLORS[id % NAME_COLORS.length];

function InfoSheet({ conv, me, onClose }: { conv: Conversation; me: number; onClose: () => void }) {
  const f = useConfig((s) => s.features);
  const peer = conv.type === 'direct' ? peerOf(conv, me) : null;
  const saved = conv.type === 'saved';
  const title = titleOf(conv, me);
  const call = (kind: 'audio' | 'video') => {
    onClose();
    if (peer) void startCall(conv.id, peer, kind);
  };

  async function clearChat() {
    const what = peer
      ? `Delete this chat with ${title}? Messages are removed for you only.`
      : saved
        ? 'Delete everything in Saved Messages?'
        : 'Clear the history of this group for you?';
    if (!window.confirm(what)) return;
    try {
      await api.clearHistory(conv.id);
      onClose();
      if (peer) {
        removeConversation(conv.id);
        goBack('/');
      } else {
        useChat.setState((s) => ({ messages: { ...s.messages, [conv.id]: [] } }));
        void ensureConversation(conv.id, true);
      }
    } catch (e) {
      toast(errorText(e));
    }
  }

  async function leave() {
    if (!window.confirm(`Leave “${title}”?`)) return;
    try {
      await api.leaveGroup(conv.id);
      onClose();
      removeConversation(conv.id);
      goBack('/');
    } catch (e) {
      toast(errorText(e));
    }
  }

  async function toggleBlock() {
    if (!peer) return;
    if (!conv.blocked && !window.confirm(`Block ${title}? They won't be able to message or call you.`)) return;
    onClose();
    await setBlocked(conv.id, peer.id, !conv.blocked);
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-hero">
          {conv.type === 'group' ? (
            <GroupHero
              conv={conv}
              me={me}
              onCall={
                f.voiceCalls
                  ? () => {
                      onClose();
                      void joinGroupCall(conv.id);
                    }
                  : undefined
              }
            />
          ) : (
            <>
              <Avatar name={title} src={peer?.avatar} saved={saved} size={96} storyOf={peer?.id} />
              <h2 dir="auto">{title}</h2>
            </>
          )}
          {peer ? (
            <>
              <p className="muted ltr-inline">
                {[peer.username && `@${peer.username}`, peer.phone].filter(Boolean).join(' · ')}
              </p>
              {peer.about && (
                <p className="sheet-about" dir="auto">
                  {peer.about}
                </p>
              )}
              {!conv.blocked && (f.voiceCalls || f.videoCalls) && (
                <div className="sheet-actions">
                  {f.voiceCalls && (
                    <button onClick={() => call('audio')}>
                      <Phone size={20} />
                      Voice
                    </button>
                  )}
                  {f.videoCalls && (
                    <button onClick={() => call('video')}>
                      <Video size={20} />
                      Video
                    </button>
                  )}
                </div>
              )}
            </>
          ) : saved ? (
            <p className="muted">Notes and messages you save. Only you can see them.</p>
          ) : null}
        </div>

        <div className="sheet-menu">
          {isGroupAdmin(conv, me) && <GroupAdminMenu conv={conv} onClose={onClose} />}
          {!saved && (
            <button className="menu-item" onClick={() => void setMuted(conv.id, !conv.muted)}>
              {conv.muted ? <Bell size={19} /> : <BellOff size={19} />}
              {conv.muted ? 'Unmute notifications' : 'Mute notifications'}
            </button>
          )}
          {peer && (
            <button className="menu-item danger" onClick={toggleBlock}>
              <Ban size={19} />
              {conv.blocked ? 'Unblock user' : 'Block user'}
            </button>
          )}
          <button className="menu-item danger" onClick={clearChat}>
            <Trash2 size={19} />
            {peer ? 'Delete chat' : 'Clear history'}
          </button>
          {conv.type === 'group' && (
            <button className="menu-item danger" onClick={leave}>
              <LogOut size={19} />
              Leave group
            </button>
          )}
        </div>

        {conv.type === 'group' && <GroupMembers conv={conv} me={me} />}
      </div>
    </div>
  );
}

type Presence = Record<number, { online: boolean; lastSeen: number }>;

function statusLine(conv: Conversation, me: number, peer: User | null, presence: Presence, typers: { name: string; kind: string }[]) {
  if (conv.type === 'saved') return 'Only you';
  if (typers.length) {
    const what = typers[0].kind === 'recording' ? 'recording a voice message…' : 'typing…';
    return conv.type === 'group' ? `${typers[0].name} is ${what}` : what;
  }
  if (peer) {
    const p = presence[peer.id];
    return p?.online ? 'Online' : formatLastSeen(p?.lastSeen ?? peer.lastSeen);
  }
  const online = conv.members.filter((m) => m.id !== me && presence[m.id]?.online).length;
  return `${conv.members.length} members${online ? `, ${online} online` : ''}`;
}

export default function ChatScreen({ id }: { id: number }) {
  const me = useChat((s) => s.me);
  const isAdmin = useAuth((s) => s.me?.role === 'admin');
  const conv = useChat((s) => s.conversations[id]);
  const messages = useChat((s) => s.messages[id]);
  const hasMore = useChat((s) => s.hasMore[id]);
  const presence = useChat((s) => s.presence);
  const typingMap = useChat((s) => s.typing[id]);
  const groupRoom = useGroupCall((s) => s.rooms[id]);
  const forwardDraft = useChat((s) => s.forwardDrafts[id]);
  const inGroupCall = useGroupCall((s) => s.conversationId === id);
  const f = useConfig((s) => s.features);
  const [missing, setMissing] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [info, setInfo] = useState(false);
  const [menu, setMenu] = useState<{ msg: Message; rect: DOMRect } | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [attach, setAttach] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [flash, setFlash] = useState(0);
  const [showDown, setShowDown] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const restore = useRef<{ height: number; top: number } | null>(null);
  const loadingOlder = useRef(false);

  useEffect(() => {
    useChat.setState({ activeId: id });
    ensureConversation(id).then((c) => !c && setMissing(true));
    loadMessages(id).catch((e) => toast(errorText(e)));
    const offVisibility = onAppVisibility(() => appVisible() && atBottom.current && markRead(id));
    return () => {
      offVisibility();
      if (useChat.getState().activeId === id) useChat.setState({ activeId: null });
    };
  }, [id]);

  const lastId = conv?.lastMessage?.id ?? 0;
  useEffect(() => {
    if (!lastId) return;
    if (!atBottom.current) setNewBelow((n) => n + 1);
    else if (appVisible()) markRead(id); // otherwise once the app is back in front
  }, [id, lastId]);

  // Stick to the bottom when new content arrives, keep position when older pages load.
  const lastMsg = messages?.[messages.length - 1];
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restore.current) {
      el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top;
      restore.current = null;
    } else if (atBottom.current || (lastMsg?.senderId === me && !lastMsg.id)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages?.length, lastMsg?.clientId, lastMsg?.id, me]);

  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [messages !== undefined]);

  async function onScroll() {
    const el = scroller.current!;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottom.current = bottom;
    setShowDown(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
    if (bottom && newBelow) {
      setNewBelow(0);
      markRead(id);
    }
    if (el.scrollTop < 160 && hasMore && !loadingOlder.current) {
      loadingOlder.current = true;
      restore.current = { height: el.scrollHeight, top: el.scrollTop };
      try {
        await loadOlder(id);
      } catch {
        restore.current = null;
      } finally {
        loadingOlder.current = false;
      }
    }
  }

  function scrollToBottom() {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setNewBelow(0);
    markRead(id);
  }

  /** Scroll to a message (loading older pages if needed) and flash it. */
  const jumpTo = useCallback(
    async (mid: number) => {
      for (let page = 0; page < 15; page++) {
        const el = scroller.current?.querySelector<HTMLElement>(`[data-mid="${mid}"]`);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setFlash(mid);
          setTimeout(() => setFlash((v) => (v === mid ? 0 : v)), 1600);
          return;
        }
        if (!useChat.getState().hasMore[id]) break;
        restore.current = scroller.current ? { height: scroller.current.scrollHeight, top: scroller.current.scrollTop } : null;
        await loadOlder(id).catch(() => {});
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      toast('That message is no longer available');
    },
    [id],
  );

  // ↑ in an empty composer edits your last message.
  useEffect(() => {
    const onEditLast = () => {
      if (!f.editMessages) return;
      const mine = [...(useChat.getState().messages[id] ?? [])].reverse().find((m) => m.senderId === me && m.id && m.type === 'text');
      if (mine) {
        setReplyTo(null);
        setEditing(mine);
      }
    };
    window.addEventListener('chaty:edit-last', onEditLast);
    return () => window.removeEventListener('chaty:edit-last', onEditLast);
  }, [id, me, f.editMessages]);

  const onMenu = useCallback((msg: Message, el: HTMLElement) => setMenu({ msg, rect: el.getBoundingClientRect() }), []);
  const onReply = useCallback(
    (msg: Message) => {
      setEditing(null);
      setForwardDraft(id, null);
      setReplyTo(msg);
    },
    [id],
  );

  // A message to forward here takes the place of a reply or an edit.
  useEffect(() => {
    if (!forwardDraft) return;
    setReplyTo(null);
    setEditing(null);
  }, [forwardDraft]);
  const onReact = useCallback((msg: Message, emoji: string) => void reactTo(msg, emoji), []);
  const onRetry = useCallback((msg: Message) => msg.clientId && retryMessage(id, msg.clientId), [id]);

  async function sendPicks(picks: Pick[], caption: string, compress: boolean) {
    setAttach(null);
    let first = true;
    for (const p of picks) {
      const common = { body: first ? caption : '', replyTo: first ? replyTo : null };
      if (p.kind === 'image' && (compress || !f.files) && f.photos) {
        const { blob, name } = compress ? await shrinkImage(p.file) : { blob: p.file, name: fileNameFor(p.file) };
        sendMessage(id, { type: 'image', file: blob, fileName: name, ...common });
      } else if (p.kind === 'video' && f.files) {
        sendMessage(id, { type: 'video', file: p.file, fileName: fileNameFor(p.file), ...common });
      } else {
        sendMessage(id, { type: 'file', file: p.file, fileName: fileNameFor(p.file), ...common });
      }
      first = false;
    }
    setReplyTo(null);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length && (f.files || f.photos)) setAttach(files);
  }

  const peer = conv?.type === 'direct' ? peerOf(conv, me) : null;
  const now = Date.now();
  const typers = conv
    ? Object.entries(typingMap ?? {})
        .filter(([uid, t]) => Number(uid) !== me && t.until > now)
        .map(([uid, t]) => ({
          name: conv.members.find((m) => m.id === Number(uid))?.name.split(' ')[0] ?? 'Someone',
          kind: t.kind,
        }))
    : [];

  // A message counts as read once every other member has read it.
  const readUpTo = useMemo(() => {
    if (!conv) return 0;
    if (conv.type === 'saved') return Number.MAX_SAFE_INTEGER; // nobody else to read them
    const others = Object.entries(conv.reads).filter(([uid]) => Number(uid) !== me).map(([, v]) => v);
    return others.length ? Math.min(...others) : 0;
  }, [conv, me]);

  if (missing) {
    return (
      <div className="screen">
        <header className="chat-header">
          <button className="icon-btn" onClick={() => goBack('/')} aria-label="Back">
            <ChevronLeft size={26} />
          </button>
        </header>
        <div className="empty">
          <p>This conversation doesn't exist or you're not a member.</p>
        </div>
      </div>
    );
  }

  const title = conv ? titleOf(conv, me) : '';
  const status = conv ? statusLine(conv, me, peer, presence, typers) : '';
  const pinned = conv?.pinned;

  return (
    <div
      className="screen chat-screen push"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <Scenery variant="full" className="chat-bg" />
      <div className="chat-bg-shade" />

      <header className="chat-header">
        <button className="icon-btn" onClick={() => goBack('/')} aria-label="Back">
          <ChevronLeft size={26} />
        </button>
        {conv && (
          <button className="chat-who" onClick={() => setInfo(true)}>
            <Avatar
              name={title}
              src={peer ? peer.avatar : conv.avatar}
              group={conv.type === 'group'}
              saved={conv.type === 'saved'}
              size={42}
              storyOf={peer?.id}
            />
            <span className="chat-who-text">
              <span className="chat-who-name" dir="auto">
                {title}
              </span>
              <span className={`chat-who-status ${typers.length ? 'accent' : ''}`}>{status}</span>
            </span>
          </button>
        )}
        <div className="spacer" />
        {peer && f.voiceCalls && !conv?.blocked && (
          <button className="icon-btn accent" onClick={() => startCall(id, peer, 'audio')} aria-label="Voice call">
            <Phone size={21} />
          </button>
        )}
        {peer && f.videoCalls && !conv?.blocked && (
          <button className="icon-btn accent" onClick={() => startCall(id, peer, 'video')} aria-label="Video call">
            <Video size={23} />
          </button>
        )}
        {conv?.type === 'group' && f.voiceCalls && (
          <button className="icon-btn accent" onClick={() => void joinGroupCall(id)} aria-label="Group call">
            <Phone size={21} />
          </button>
        )}
        <button className="icon-btn accent" onClick={() => setInfo(true)} aria-label="Details">
          <EllipsisVertical size={21} />
        </button>
      </header>
      <PlayerBar />
      {groupRoom && !inGroupCall && (
        <div className="pinned-bar gcall-bar" onClick={() => void joinGroupCall(id)}>
          <Phone size={16} />
          <div className="pinned-text">
            <span className="pinned-title">Group call</span>
            <span className="pinned-body">{groupRoom.participants.length} in the call</span>
          </div>
          <button className="btn btn-primary small">Join</button>
        </div>
      )}

      {pinned && (
        <div className="pinned-bar" onClick={() => jumpTo(pinned.id)}>
          <Pin size={16} />
          <div className="pinned-text">
            <span className="pinned-title">Pinned message</span>
            <span className="pinned-body" dir="auto">
              {previewOf(pinned)}
            </span>
          </div>
          <button
            className="icon-btn"
            aria-label="Unpin"
            onClick={(e) => {
              e.stopPropagation();
              void pinMessage(id, null);
            }}
          >
            <X size={18} />
          </button>
        </div>
      )}

      <div className="scroll messages" ref={scroller} onScroll={onScroll}>
        <div className="messages-inner" ref={content}>
          {messages === undefined ? (
            <div className="loading-dots">
              <span />
              <span />
              <span />
            </div>
          ) : messages.length === 0 && conv?.type === 'saved' ? (
            <div className="say-hi">
              <span className="say-hi-emoji">🔖</span>
              <p>Keep notes here, or tap Save on any message to keep a copy. Only you can see them.</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="say-hi">
              <span className="say-hi-emoji">👋</span>
              <p>Say hi to {title}</p>
              <button className="btn btn-primary" onClick={() => sendMessage(id, { type: 'text', body: 'Hi! 👋' })}>
                Send a wave
              </button>
            </div>
          ) : (
            messages.map((m, i) => {
              const prev = messages[i - 1];
              const next = messages[i + 1];
              const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
              const tail =
                !next ||
                next.senderId !== m.senderId ||
                !sameDay(next.createdAt, m.createdAt) ||
                next.createdAt - m.createdAt > 5 * 60_000;
              const mine = m.senderId === me;
              const showSender = conv?.type === 'group' && !mine && (newDay || prev?.senderId !== m.senderId);
              const sender = showSender ? conv?.members.find((u) => u.id === m.senderId) : undefined;
              return (
                <div key={m.clientId || m.id}>
                  {newDay && (
                    <div className="day-sep">
                      <span>{formatDay(m.createdAt)}</span>
                    </div>
                  )}
                  <MessageBubble
                    msg={m}
                    me={me}
                    mine={mine}
                    read={mine && m.id > 0 && m.id <= readUpTo}
                    tail={tail}
                    highlight={flash === m.id}
                    senderName={showSender ? (sender?.name ?? 'Someone') : undefined}
                    senderColor={nameColor(m.senderId)}
                    replyName={m.reply ? nameOf(m.reply.senderId, conv) : undefined}
                    onMenu={onMenu}
                    onReply={onReply}
                    onJump={jumpTo}
                    onReact={onReact}
                    onRetry={onRetry}
                    onOpenImage={setImage}
                  />
                </div>
              );
            })
          )}
          {typers.length > 0 && (
            <div className="msg-row in tail">
              <div className="bubble bubble-in typing-bubble">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
        </div>
      </div>

      {showDown && (
        <button className="scroll-down" onClick={scrollToBottom} aria-label="Scroll to latest">
          <ChevronDown size={24} />
          {newBelow > 0 && <span className="badge">{newBelow}</span>}
        </button>
      )}

      {conv?.blocked && peer ? (
        <div className="blocked-bar">
          <span>You blocked {peer.name}</span>
          <button className="btn btn-ghost small" onClick={() => void setBlocked(id, peer.id, false)}>
            Unblock
          </button>
        </div>
      ) : conv?.onlyAdmins && !isGroupAdmin(conv, me) ? (
        <div className="blocked-bar">
          <span>Only admins can send messages</span>
        </div>
      ) : (
      <Composer
        conversationId={id}
        replyTo={replyTo}
        replyName={replyTo ? nameOf(replyTo.senderId, conv) : ''}
        editing={editing}
        forwarding={forwardDraft ?? null}
        forwardName={forwardDraft ? forwardDraft.forwardedFrom || nameOf(forwardDraft.senderId, useChat.getState().conversations[forwardDraft.conversationId]) : ''}
        onDone={() => {
          setReplyTo(null);
          setEditing(null);
          setForwardDraft(id, null);
        }}
        onFiles={setAttach}
      />
      )}

      {dragging && (
        <div className="drop-overlay">
          <Paperclip size={34} />
          <span>Drop files to send</span>
        </div>
      )}
      {image && (
        <div className="viewer" onClick={() => setImage(null)}>
          <button className="icon-btn viewer-close" aria-label="Close">
            <X size={26} />
          </button>
          <img src={image} alt="" />
        </div>
      )}
      {menu && (
        <MessageMenu
          msg={menu.msg}
          anchor={menu.rect}
          mine={menu.msg.senderId === me}
          isAdmin={isAdmin}
          saved={conv?.type === 'saved'}
          pinned={pinned?.id === menu.msg.id}
          onClose={() => setMenu(null)}
          onReply={() => onReply(menu.msg)}
          onEdit={() => {
            setReplyTo(null);
            setEditing(menu.msg);
          }}
          onPin={() => void pinMessage(id, pinned?.id === menu.msg.id ? null : menu.msg)}
          onForward={() => setForwarding(menu.msg)}
          onDelete={(forAll) => void deleteMessage(menu.msg, forAll)}
          onReact={(e) => void reactTo(menu.msg, e)}
          onRetry={() => onRetry(menu.msg)}
        />
      )}
      {forwarding && <ForwardSheet msg={forwarding} onClose={() => setForwarding(null)} />}
      {attach && <AttachSheet files={attach} onClose={() => setAttach(null)} onSend={sendPicks} />}
      {info && conv && <InfoSheet conv={conv} me={me} onClose={() => setInfo(false)} />}
    </div>
  );
}
