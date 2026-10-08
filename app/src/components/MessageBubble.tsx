import { Check, CheckCheck, CircleAlert, Clock, Download, FileText, Forward, Reply } from 'lucide-react';
import { memo, useRef, useState } from 'react';
import { mediaUrl } from '../lib/config';
import { formatBytes, formatTime } from '../lib/format';
import type { Message } from '../lib/types';
import { previewOf } from '../store/chat';
import AudioMessage from './AudioMessage';

interface Props {
  msg: Message;
  mine: boolean;
  me: number;
  read: boolean;
  tail: boolean;
  highlight: boolean;
  senderName?: string;
  senderColor?: string;
  replyName?: string;
  onMenu: (msg: Message, el: HTMLElement) => void;
  onReply: (msg: Message) => void;
  onJump: (id: number) => void;
  onReact: (msg: Message, emoji: string) => void;
  onRetry: (msg: Message) => void;
  onOpenImage: (src: string) => void;
}

function Ticks({ msg, read }: { msg: Message; read: boolean }) {
  if (msg.status === 'failed') return <CircleAlert size={14} className="tick-failed" />;
  if (msg.status === 'sending' || !msg.id) return <Clock size={12} />;
  if (read) return <CheckCheck size={15} className="tick-read" />;
  return <Check size={15} />;
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </>
  );
}

function fileHref(m: Message) {
  return `${mediaUrl(m.mediaUrl)}?name=${encodeURIComponent(m.fileName || 'file')}`;
}

/** Long-press / right-click opens the menu, swiping left replies (touch). */
function useGestures(msg: Message, onMenu: Props['onMenu'], onReply: Props['onReply']) {
  const row = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; t: number; timer: number; swiping: boolean; fired: boolean } | null>(null);
  const [dx, setDx] = useState(0);

  const openMenu = () => bubble.current && onMenu(msg, bubble.current);

  const handlers = {
    onPointerDown(e: React.PointerEvent) {
      if (e.button !== 0) return;
      const st = { x: e.clientX, y: e.clientY, t: Date.now(), timer: 0, swiping: false, fired: false };
      st.timer = window.setTimeout(() => {
        st.fired = true;
        navigator.vibrate?.(12);
        openMenu();
      }, 480);
      press.current = st;
    },
    onPointerMove(e: React.PointerEvent) {
      const st = press.current;
      if (!st) return;
      const mx = e.clientX - st.x;
      const my = e.clientY - st.y;
      if (Math.abs(mx) > 8 || Math.abs(my) > 8) clearTimeout(st.timer);
      if (e.pointerType === 'touch' && msg.type !== 'deleted' && msg.id) {
        if (!st.swiping && mx < -12 && Math.abs(mx) > Math.abs(my) * 1.5) st.swiping = true;
        if (st.swiping) setDx(Math.max(-80, Math.min(0, mx)));
      }
    },
    onPointerUp() {
      const st = press.current;
      if (!st) return;
      clearTimeout(st.timer);
      if (st.swiping && dx <= -56) onReply(msg);
      setDx(0);
      press.current = st.fired ? { ...st, fired: true } : null;
      // keep `fired` long enough for the click that follows a long press
      if (st.fired) setTimeout(() => (press.current = null), 50);
    },
    onPointerCancel() {
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
      setDx(0);
    },
    onContextMenu(e: React.MouseEvent) {
      e.preventDefault();
      openMenu();
    },
  };

  const longPressed = () => !!press.current?.fired;
  return { row, bubble, dx, handlers, openMenu, longPressed };
}

function MessageBubble(p: Props) {
  const { msg, mine } = p;
  const { row, bubble, dx, handlers, openMenu, longPressed } = useGestures(msg, p.onMenu, p.onReply);
  const src = msg.localUrl || mediaUrl(msg.mediaUrl);
  const deleted = msg.type === 'deleted';
  const sending = !msg.id && msg.status === 'sending';

  const meta = (
    <span className="msg-meta">
      {msg.editedAt ? <span className="msg-edited">edited</span> : null}
      {formatTime(msg.createdAt)}
      {mine && !deleted && <Ticks msg={msg} read={p.read} />}
    </span>
  );

  // A plain tap on a text bubble opens the menu, like Telegram.
  function onClick(e: React.MouseEvent) {
    if (longPressed()) return;
    if (msg.status === 'failed') return p.onRetry(msg);
    const target = e.target as HTMLElement;
    if (target.closest('a, button, video, audio, .audio-msg, .msg-reply')) return;
    if (msg.type === 'text' || deleted || msg.type === 'file') openMenu();
  }

  const reactions = Object.entries(msg.reactions ?? {}).filter(([, users]) => users.length);

  return (
    <div
      ref={row}
      className={`msg-row ${mine ? 'out' : 'in'} ${p.tail ? 'tail' : ''} ${p.highlight ? 'flash' : ''}`}
      data-mid={msg.id || undefined}
      {...handlers}
      onDoubleClick={() => msg.id && !deleted && p.onReply(msg)}
    >
      {dx < 0 && (
        <span className="swipe-reply" style={{ opacity: Math.min(1, -dx / 56) }}>
          <Reply size={18} />
        </span>
      )}
      <div className="msg-stack" style={dx ? { transform: `translateX(${dx}px)` } : undefined}>
        <div
          ref={bubble}
          className={`bubble ${mine ? 'bubble-out' : 'bubble-in'} bubble-${msg.type} ${msg.reply ? 'has-reply' : ''}`}
          onClick={onClick}
        >
          {p.senderName && (
            <div className="msg-sender" style={{ color: p.senderColor }}>
              {p.senderName}
            </div>
          )}
          {msg.forwardedFrom && (
            <div className="msg-forwarded">
              <Forward size={13} /> Forwarded from <b>{msg.forwardedFrom}</b>
            </div>
          )}
          {msg.reply && (
            <button className="msg-reply" onClick={() => p.onJump(msg.reply!.id)}>
              <span className="msg-reply-name">{p.replyName}</span>
              <span className="msg-reply-text" dir="auto">
                {previewOf(msg.reply)}
              </span>
            </button>
          )}

          {deleted && (
            <div className="msg-text msg-deleted">
              🚫 This message was deleted
              {meta}
            </div>
          )}
          {msg.type === 'image' && (
            <button className="msg-image" onClick={() => !sending && p.onOpenImage(src)}>
              <img src={src} alt="Photo" loading="lazy" />
              {sending && <Progress value={msg.progress} />}
            </button>
          )}
          {msg.type === 'video' && (
            <div className="msg-video">
              <video src={src} controls playsInline preload="metadata" />
              {sending && <Progress value={msg.progress} />}
            </div>
          )}
          {msg.type === 'audio' && <AudioMessage src={src} duration={msg.duration} seed={msg.id || msg.createdAt} />}
          {msg.type === 'file' && (
            <a className="msg-file" href={sending ? undefined : fileHref(msg)} target="_blank" rel="noreferrer" download={msg.fileName}>
              <span className="msg-file-icon">
                {sending ? <Progress value={msg.progress} small /> : <FileText size={22} />}
              </span>
              <span className="msg-file-text">
                <span className="msg-file-name" dir="auto">
                  {msg.fileName || 'File'}
                </span>
                <span className="msg-file-size">
                  {sending && msg.progress !== undefined
                    ? `${Math.round((msg.progress ?? 0) * 100)}% · ${formatBytes(msg.fileSize)}`
                    : formatBytes(msg.fileSize)}
                </span>
              </span>
              {!sending && <Download size={18} className="msg-file-dl" />}
            </a>
          )}

          {msg.type === 'text' ? (
            <div className="msg-text" dir="auto">
              <Linkified text={msg.body} />
              {meta}
            </div>
          ) : (
            !deleted && (
              <div className={`msg-media-meta ${msg.body ? 'has-caption' : ''}`}>
                {msg.body && (
                  <span className="msg-caption" dir="auto">
                    <Linkified text={msg.body} />
                  </span>
                )}
                {meta}
              </div>
            )
          )}
          {msg.status === 'failed' && <div className="msg-failed">Not sent · tap to retry</div>}
        </div>
        {reactions.length > 0 && (
          <div className="reactions">
            {reactions.map(([emoji, users]) => (
              <button
                key={emoji}
                className={`reaction ${users.includes(p.me) ? 'mine' : ''}`}
                onClick={() => p.onReact(msg, emoji)}
              >
                <span>{emoji}</span>
                {users.length > 1 && <span className="reaction-count">{users.length}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Progress({ value = 0, small }: { value?: number; small?: boolean }) {
  const r = small ? 14 : 20;
  const c = 2 * Math.PI * r;
  return (
    <span className={`progress-ring ${small ? 'small' : ''}`}>
      <svg viewBox={`0 0 ${r * 2 + 6} ${r * 2 + 6}`}>
        <circle cx={r + 3} cy={r + 3} r={r} className="track" />
        <circle
          cx={r + 3}
          cy={r + 3}
          r={r}
          className="bar"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(0.03, value))}
        />
      </svg>
    </span>
  );
}

export default memo(MessageBubble);
