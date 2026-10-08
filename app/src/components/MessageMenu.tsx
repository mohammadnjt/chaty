import { Copy, Forward, Pencil, Pin, PinOff, Reply, RotateCw, Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { copyText } from '../lib/format';
import type { Message } from '../lib/types';
import { useConfig } from '../store/config';
import { toast } from '../store/toast';

export const QUICK_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏', '🔥', '👏'];

interface Props {
  msg: Message;
  anchor: DOMRect;
  mine: boolean;
  isAdmin: boolean;
  pinned: boolean;
  onClose: () => void;
  onReply: () => void;
  onEdit: () => void;
  onPin: () => void;
  onForward: () => void;
  onDelete: (forAll: boolean) => void;
  onReact: (emoji: string) => void;
  onRetry: () => void;
}

export default function MessageMenu(p: Props) {
  const f = useConfig((s) => s.features);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { msg } = p;
  const deleted = msg.type === 'deleted';
  const sent = msg.id > 0;
  const text = msg.body;

  // Place the menu next to the message, inside the app frame.
  useLayoutEffect(() => {
    const el = box.current;
    const frame = el?.offsetParent?.getBoundingClientRect();
    if (!el || !frame) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let top = p.anchor.bottom - frame.top + 8;
    if (top + h > frame.height - 12) top = p.anchor.top - frame.top - h - 8;
    top = Math.max(12, Math.min(top, frame.height - h - 12));
    let left = p.mine ? p.anchor.right - frame.left - w : p.anchor.left - frame.left;
    left = Math.max(10, Math.min(left, frame.width - w - 10));
    setPos({ top, left });
  }, [p.anchor, p.mine, confirmDelete]);

  const act = (fn: () => void) => () => {
    fn();
    p.onClose();
  };

  return (
    <div className="menu-backdrop" onClick={p.onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={box}
        className="msg-menu"
        style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        {confirmDelete ? (
          <>
            <p className="menu-title">Delete this message?</p>
            <button className="menu-item danger" onClick={act(() => p.onDelete(false))}>
              <Trash2 size={18} /> Delete for me
            </button>
            {(p.mine || p.isAdmin) && sent && !deleted && (
              <button className="menu-item danger" onClick={act(() => p.onDelete(true))}>
                <Trash2 size={18} /> Delete for everyone
              </button>
            )}
            <button className="menu-item" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {f.reactions && sent && !deleted && (
              <div className="menu-reactions">
                {QUICK_REACTIONS.map((e) => (
                  <button key={e} onClick={act(() => p.onReact(e))}>
                    {e}
                  </button>
                ))}
              </div>
            )}
            {msg.status === 'failed' && (
              <button className="menu-item" onClick={act(p.onRetry)}>
                <RotateCw size={18} /> Retry
              </button>
            )}
            {sent && !deleted && (
              <button className="menu-item" onClick={act(p.onReply)}>
                <Reply size={18} /> Reply
              </button>
            )}
            {text && !deleted && (
              <button
                className="menu-item"
                onClick={act(async () => toast((await copyText(text)) ? 'Copied' : "Couldn't copy"))}
              >
                <Copy size={18} /> Copy {msg.type === 'text' ? 'text' : 'caption'}
              </button>
            )}
            {f.editMessages && p.mine && sent && !deleted && (msg.type === 'text' || msg.type !== 'audio') && (
              <button className="menu-item" onClick={act(p.onEdit)}>
                <Pencil size={18} /> Edit
              </button>
            )}
            {sent && !deleted && (
              <button className="menu-item" onClick={act(p.onPin)}>
                {p.pinned ? <PinOff size={18} /> : <Pin size={18} />} {p.pinned ? 'Unpin' : 'Pin'}
              </button>
            )}
            {f.forwarding && sent && !deleted && (
              <button className="menu-item" onClick={act(p.onForward)}>
                <Forward size={18} /> Forward
              </button>
            )}
            {(f.deleteMessages || !sent) && (
              <button
                className="menu-item danger"
                onClick={() => (sent ? setConfirmDelete(true) : act(() => p.onDelete(false))())}
              >
                <Trash2 size={18} /> Delete
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
