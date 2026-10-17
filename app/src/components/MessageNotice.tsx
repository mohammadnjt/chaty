import { Reply, SendHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorText } from '../lib/api';
import { mediaUrl } from '../lib/config';
import { formatTime } from '../lib/format';
import { navigate } from '../lib/router';
import { isGroupAdmin, peerOf, previewOf, quickReply, titleOf, useChat } from '../store/chat';
import { dismissNotice, useNotice, type Notice } from '../store/notice';
import { toast } from '../store/toast';
import Avatar from './Avatar';
import Sticker from './Sticker';

const SHOWN_FOR = 5000;

/** The banner for a message from another chat (store/notice.ts). */
export function NoticeHost() {
  const notice = useNotice((s) => s.notice);
  return notice ? <MessageNotice key={notice.conversationId} notice={notice} /> : null;
}

function MessageNotice({ notice }: { notice: Notice }) {
  const me = useChat((s) => s.me);
  const conv = useChat((s) => s.conversations[notice.conversationId]);
  const active = useChat((s) => s.activeId);
  const replying = useNotice((s) => s.replying);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [held, setHeld] = useState(false);
  const [dy, setDy] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const msg = notice.message;

  const close = () => {
    setLeaving(true);
    setTimeout(dismissNotice, 180);
  };

  // Goes away by itself, but not while a finger or the pointer is on it, or while replying.
  useEffect(() => {
    if (held || replying || leaving) return;
    const t = setTimeout(close, SHOWN_FOR);
    return () => clearTimeout(t);
  }, [notice.shownAt, held, replying, leaving]);

  // Opening that chat some other way: it's seen.
  useEffect(() => {
    if (active === notice.conversationId) dismissNotice();
  }, [active, notice.conversationId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!conv) return null;
  const group = conv.type === 'group';
  const sender = conv.members.find((m) => m.id === msg.senderId);
  const title = titleOf(conv, me);
  const preview = previewOf(msg);
  const canReply = !conv.blocked && (!conv.onlyAdmins || isGroupAdmin(conv, me));

  function open() {
    dismissNotice();
    navigate(`/chat/${conv.id}`);
  }

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      // In a group, the answer quotes the message, since others may write in between.
      await quickReply(conv.id, body, group ? msg : undefined);
      toast(`Sent to ${title}`);
      dismissNotice();
    } catch (e) {
      toast(errorText(e));
      setSending(false);
    }
  }

  // Swipe up to dismiss; a tap without moving opens the chat.
  const gestures = {
    onPointerDown(e: React.PointerEvent) {
      if ((e.target as HTMLElement).closest('button, input')) return;
      drag.current = { y: e.clientY, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: React.PointerEvent) {
      const d = drag.current;
      if (!d) return;
      const off = e.clientY - d.y;
      if (Math.abs(off) > 6) d.moved = true;
      setDy(off < 0 ? off : off / 4);
    },
    onPointerUp() {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (dy < -40) close();
      else if (!d.moved) open();
      setDy(0);
    },
    onPointerCancel() {
      drag.current = null;
      setDy(0);
    },
  };

  return (
    <div
      className={`notice ${drag.current ? 'dragging' : ''} ${leaving ? 'leaving' : ''}`}
      style={dy ? { transform: `translateY(${dy}px)` } : undefined}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      role="alert"
    >
      <div className="notice-main" {...gestures}>
        <Avatar
          name={title}
          src={group ? conv.avatar : (sender ?? peerOf(conv, me))?.avatar}
          group={group}
          saved={conv.type === 'saved'}
          size={42}
        />
        <div className="notice-text">
          <span className="notice-title">
            <span className="notice-name" dir="auto">
              {title}
            </span>
            {notice.count > 1 && <span className="notice-count">{notice.count}</span>}
            <span className="notice-time">{formatTime(msg.createdAt)}</span>
          </span>
          <span className="notice-body" dir="auto">
            {group && <b>{sender?.name.split(' ')[0] ?? 'Someone'}: </b>}
            {preview}
          </span>
        </div>
        {msg.type === 'image' && msg.mediaUrl && <img className="notice-thumb" src={mediaUrl(msg.mediaUrl)} alt="" />}
        {msg.type === 'sticker' && msg.mediaUrl && <Sticker url={msg.mediaUrl} size={42} play="hover" />}
        {replying ? (
          <button className="icon-btn notice-close" onClick={close} aria-label="Close">
            <X size={20} />
          </button>
        ) : (
          canReply && (
            <button className="notice-reply-btn" onClick={() => useNotice.setState({ replying: true })}>
              <Reply size={15} /> Reply
            </button>
          )
        )}
      </div>
      {replying && (
        <div className="notice-reply">
          <input
            className="field"
            value={text}
            dir="auto"
            autoFocus
            enterKeyHint="send"
            placeholder={`Reply to ${group ? (sender?.name.split(' ')[0] ?? title) : title}…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void send()}
          />
          <button className="send-btn" disabled={!text.trim() || sending} onClick={() => void send()} aria-label="Send">
            <SendHorizontal size={19} />
          </button>
        </div>
      )}
    </div>
  );
}
