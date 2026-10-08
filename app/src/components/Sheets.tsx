import { FileText, Film, Send, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '../lib/format';
import type { Conversation } from '../lib/types';
import { activityOf, peerOf, titleOf, useChat } from '../store/chat';
import { useConfig } from '../store/config';
import Avatar from './Avatar';

// ---------- forward ----------

export function ForwardSheet({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (conv: Conversation) => void;
}) {
  const me = useChat((s) => s.me);
  const conversations = useChat((s) => s.conversations);
  const [q, setQ] = useState('');
  const list = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => titleOf(c, me).toLowerCase().includes(q.trim().toLowerCase()))
        .sort((a, b) => activityOf(b) - activityOf(a)),
    [conversations, me, q],
  );
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
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" />
          </label>
        </div>
        <div className="sheet-list">
          {list.map((c) => {
            const peer = c.type === 'direct' ? peerOf(c, me) : null;
            const title = titleOf(c, me);
            return (
              <button key={c.id} className="user-row" onClick={() => onPick(c)}>
                <Avatar name={title} src={peer ? peer.avatar : c.avatar} group={!peer} size={44} />
                <div className="user-row-body">
                  <span className="user-name" dir="auto">
                    {title}
                  </span>
                  <span className="user-sub">{c.type === 'group' ? `${c.members.length} members` : 'Direct chat'}</span>
                </div>
              </button>
            );
          })}
          {list.length === 0 && <p className="muted pad">No chats found.</p>}
        </div>
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
