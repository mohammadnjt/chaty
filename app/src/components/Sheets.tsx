import { Check, FileText, Film, Forward, Send, SendHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { errorText } from '../lib/api';
import { formatBytes } from '../lib/format';
import { navigate } from '../lib/router';
import type { Message } from '../lib/types';
import { activityOf, forwardWithComment, openSaved, peerOf, previewOf, setForwardDraft, titleOf, useChat } from '../store/chat';
import { useConfig } from '../store/config';
import { toast } from '../store/toast';
import Avatar from './Avatar';

// ---------- forward ----------

const SAVED = -1; // Saved Messages before it's ever been opened: made when used

/**
 * Forwarding a message: tick one chat or several, nothing goes until you say.
 * One chat opens it with the message waiting above the composer, like a
 * reply; for several, add a comment here and send it to all of them.
 */
export function ForwardSheet({ msg, onClose }: { msg: Message; onClose: () => void }) {
  const me = useChat((s) => s.me);
  const conversations = useChat((s) => s.conversations);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const query = q.trim().toLowerCase();
  // Saved Messages first: forwarding there is how you save a message.
  const list = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => titleOf(c, me).toLowerCase().includes(query))
        .sort((a, b) => Number(b.type === 'saved') - Number(a.type === 'saved') || activityOf(b) - activityOf(a)),
    [conversations, me, query],
  );
  const savedMissing = !Object.values(conversations).some((c) => c.type === 'saved') && 'saved messages'.includes(query);
  const nameOfPick = (id: number) => (id === SAVED ? 'Saved Messages' : titleOf(conversations[id], me));

  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const targets = () => Promise.all(picked.map((id) => (id === SAVED ? openSaved().then((c) => c.id) : id)));

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      onClose();
    } catch (e) {
      toast(errorText(e));
      setBusy(false);
    }
  }

  // One chat: open it with the message above the composer.
  const openChat = () =>
    run(async () => {
      const [id] = await targets();
      setForwardDraft(id, msg);
      navigate(`/chat/${id}`);
    });

  // Several: send it (after the comment) to all of them now.
  const sendAll = () =>
    run(async () => {
      const ids = await targets();
      await forwardWithComment(msg, ids, comment);
      toast(`Forwarded to ${ids.length} chats`);
    });

  const row = (id: number, title: string, sub: string, avatar: React.ReactNode) => {
    const on = picked.includes(id);
    return (
      <button key={id} className={`user-row ${on ? 'picked-row' : ''}`} onClick={() => toggle(id)}>
        {avatar}
        <div className="user-row-body">
          <span className="user-name" dir="auto">
            {title}
          </span>
          <span className="user-sub">{sub}</span>
        </div>
        <span className={`check ${on ? 'on' : ''}`}>{on && <Check size={16} strokeWidth={3} />}</span>
      </button>
    );
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h3>Forward to…</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={22} />
          </button>
        </div>
        <div className="search-wrap">
          <label className="search">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" />
          </label>
        </div>
        <div className="sheet-list">
          {savedMissing && row(SAVED, 'Saved Messages', 'Only you', <Avatar name="Saved Messages" saved size={44} />)}
          {list.map((c) => {
            const peer = c.type === 'direct' ? peerOf(c, me) : null;
            const title = titleOf(c, me);
            const sub = c.type === 'group' ? `${c.members.length} members` : c.type === 'saved' ? 'Only you' : 'Direct chat';
            return row(
              c.id,
              title,
              sub,
              <Avatar name={title} src={peer ? peer.avatar : c.avatar} group={c.type === 'group'} saved={c.type === 'saved'} size={44} />,
            );
          })}
          {list.length === 0 && !savedMissing && <p className="muted pad">No chats found.</p>}
        </div>

        {picked.length > 0 && (
          <div className="forward-bar">
            <div className="composer-context">
              <Forward size={18} />
              <div className="composer-context-text">
                <span className="composer-context-title" dir="auto">
                  {picked.length === 1 ? `Forward to ${nameOfPick(picked[0])}` : `Forward to ${picked.length} chats`}
                </span>
                <span className="composer-context-body" dir="auto">
                  {previewOf(msg)}
                </span>
              </div>
            </div>
            {picked.length === 1 ? (
              <button className="btn btn-primary forward-go" disabled={busy} onClick={() => void openChat()}>
                Forward
              </button>
            ) : (
              <div className="forward-send">
                <input
                  className="field"
                  value={comment}
                  dir="auto"
                  placeholder="Add a comment…"
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !busy && void sendAll()}
                />
                <button className="send-btn" disabled={busy} onClick={() => void sendAll()} aria-label={`Send to ${picked.length} chats`}>
                  <SendHorizontal size={21} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- attachments preview ----------

export interface Pick {
  file: File;
  url: string;
  kind: 'image' | 'video' | 'audio' | 'file';
}

export function classify(file: File): Pick['kind'] {
  if (/^image\/(jpeg|png|gif|webp|bmp)$/.test(file.type)) return 'image';
  if (/^video\/(mp4|webm|quicktime)$/.test(file.type)) return 'video';
  if (/^audio\//.test(file.type)) return 'audio';
  return 'file';
}

export function AttachSheet({
  files,
  onClose,
  onSend,
}: {
  files: File[];
  onClose: () => void;
  onSend: (picks: Pick[], caption: string, compress: boolean) => void;
}) {
  const f = useConfig((s) => s.features);
  const maxMB = useConfig((s) => s.maxUploadMB);
  const [caption, setCaption] = useState('');
  const [compress, setCompress] = useState(true);

  const picks = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file), kind: classify(file) }) as Pick),
    [files],
  );
  useEffect(() => () => picks.forEach((p) => URL.revokeObjectURL(p.url)), [picks]);

  const tooBig = picks.filter((p) => p.file.size > maxMB * 1024 * 1024);
  const blocked = picks.filter((p) => (p.kind === 'image' ? !f.photos && !f.files : !f.files));
  const hasImages = picks.some((p) => p.kind === 'image');
  const ok = picks.length > 0 && tooBig.length === 0 && blocked.length === 0;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet attach-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h3>
            Send {picks.length} {picks.length === 1 ? 'item' : 'items'}
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={22} />
          </button>
        </div>
        <div className={`attach-grid ${picks.length === 1 ? 'single' : ''}`}>
          {picks.map((p, i) =>
            p.kind === 'image' ? (
              <img key={i} src={p.url} alt="" />
            ) : p.kind === 'video' ? (
              <div key={i} className="attach-video">
                <video src={p.url} muted playsInline preload="metadata" />
                <Film size={18} />
              </div>
            ) : (
              <div key={i} className="attach-file">
                <FileText size={22} />
                <span className="attach-file-name" dir="auto">
                  {p.file.name}
                </span>
                <span className="muted small">{formatBytes(p.file.size)}</span>
              </div>
            ),
          )}
        </div>
        {tooBig.length > 0 && <p className="form-error">Files must be smaller than {maxMB} MB.</p>}
        {blocked.length > 0 && <p className="form-error">Sending this kind of file is turned off by the admin.</p>}
        {hasImages && f.files && (
          <label className="toggle-row">
            <input type="checkbox" checked={compress} onChange={(e) => setCompress(e.target.checked)} />
            Compress photos (faster to send)
          </label>
        )}
        <div className="attach-caption">
          <input
            className="field"
            placeholder="Add a caption…"
            value={caption}
            dir="auto"
            autoFocus
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ok && onSend(picks, caption.trim(), compress)}
          />
          <button className="send-btn" disabled={!ok} onClick={() => onSend(picks, caption.trim(), compress)} aria-label="Send">
            <Send size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
