import { ArrowDown, ArrowUp, Check, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Sticker from '../components/Sticker';
import { api, errorText } from '../lib/api';
import { socket } from '../lib/socket';
import type { Sticker as StickerData, StickerPack } from '../lib/types';
import { toast } from '../store/toast';

const UNSORTED = 0;

/**
 * The admin panel's Stickers tab. Uploads (files, or a pack exported from
 * Telegram as a .zip) go into the group on screen: Unsorted or a pack. Pick
 * the stickers you want and move them into a pack; delete the rest.
 */
export default function StickersTab() {
  const [data, setData] = useState<{ packs: StickerPack[]; unsorted: StickerData[] } | null>(null);
  const [view, setView] = useState(UNSORTED);
  const [picked, setPicked] = useState<number[]>([]);
  const [title, setTitle] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = () =>
    api.admin
      .stickers()
      .then(setData)
      .catch((e) => toast(errorText(e)));

  useEffect(() => {
    void load();
    return socket.on('stickers', () => void load());
  }, []);

  const pack = data?.packs.find((p) => p.id === view);
  const shown = (view === UNSORTED ? data?.unsorted : pack?.stickers) ?? [];

  // A pack deleted (here or by another admin): back to the unsorted ones.
  useEffect(() => {
    if (data && view !== UNSORTED && !pack) setView(UNSORTED);
  }, [data, view, pack]);
  useEffect(() => setPicked([]), [view]);
  useEffect(() => setTitle(pack?.title ?? ''), [pack?.id, pack?.title]);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
      setPicked([]);
      await load();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function upload(files: File[]) {
    if (!files.length) return;
    setProgress(0);
    try {
      const r = await api.admin.uploadStickers(files, view, setProgress);
      toast(`${r.added} sticker${r.added === 1 ? '' : 's'} added${r.skipped ? `; ${r.skipped} file${r.skipped === 1 ? ' wasn’t a sticker' : 's weren’t stickers'}` : ''}`);
      await load();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setProgress(null);
    }
  }

  async function newPack(): Promise<StickerPack | null> {
    const name = window.prompt('Name of the new pack')?.trim();
    if (!name) return null;
    try {
      return await api.admin.createStickerPack(name);
    } catch (e) {
      toast(errorText(e));
      return null;
    }
  }

  async function addPack() {
    const p = await newPack();
    if (!p) return;
    await load();
    setView(p.id);
  }

  async function moveTo(target: string) {
    if (!target) return;
    let to: StickerPack | null = null; // Unsorted
    if (target !== '0') {
      to = target === 'new' ? await newPack() : (data?.packs.find((p) => p.id === Number(target)) ?? null);
      if (!to) return;
    }
    await run(() => api.admin.moveStickers(picked, to?.id ?? UNSORTED), `Moved ${picked.length} to ${to?.title ?? 'Unsorted'}`);
  }

  function deletePicked() {
    const n = picked.length;
    if (window.confirm(`Delete ${n} sticker${n === 1 ? '' : 's'}? Ones already sent stay in the chats.`)) {
      void run(() => api.admin.deleteStickers(picked), `Deleted ${n} sticker${n === 1 ? '' : 's'}`);
    }
  }

  function deletePack() {
    if (!pack) return;
    const n = pack.stickers.length;
    if (window.confirm(`Delete the pack “${pack.title}” and its ${n} sticker${n === 1 ? '' : 's'}? It's taken away from everyone who added it; stickers already sent stay in the chats.`)) {
      void run(() => api.admin.deleteStickerPack(pack.id), 'Pack deleted');
    }
  }

  function shift(dir: -1 | 1) {
    const ids = data!.packs.map((p) => p.id);
    const i = ids.indexOf(view);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void run(() => api.admin.orderStickerPacks(ids));
  }

  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const allPicked = shown.length > 0 && picked.length === shown.length;

  if (!data) return <p className="muted pad">Loading…</p>;
  const at = data.packs.findIndex((p) => p.id === view);

  return (
    <>
      <div className="card form-card">
        <p className="muted small">
          Upload stickers one by one, or a whole pack as a <b>.zip</b>: WebP, PNG or GIF pictures, WebM video stickers and
          animated <b>.tgs</b>. They go into the group picked below. Tap stickers to pick them, then move them into a pack or
          delete the ones you don't want. People add packs from Saved Messages.
        </p>
        <button className="btn btn-primary wide" disabled={progress !== null} onClick={() => file.current?.click()}>
          <Upload size={18} />
          <span className="ellipsis" dir="auto">
            {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : `Upload to ${pack ? pack.title : 'Unsorted'}`}
          </span>
        </button>
        <input
          ref={file}
          type="file"
          multiple
          hidden
          accept=".zip,.webp,.png,.gif,.jpg,.jpeg,.webm,.tgs,.json"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void upload(files);
          }}
        />
      </div>

      <div className="chips pad-x">
        <button className={`chip ${view === UNSORTED ? 'on' : ''}`} onClick={() => setView(UNSORTED)}>
          Unsorted ({data.unsorted.length})
        </button>
        {data.packs.map((p) => (
          <button key={p.id} className={`chip ${view === p.id ? 'on' : ''}`} onClick={() => setView(p.id)} dir="auto">
            {p.title} ({p.stickers.length})
          </button>
        ))}
        <button className="chip new-pack" disabled={busy} onClick={() => void addPack()}>
          <Plus size={13} /> New pack
        </button>
      </div>

      {pack && (
        <div className="card form-card">
          <div className="pack-name">
            <input className="field" value={title} dir="auto" onChange={(e) => setTitle(e.target.value)} placeholder="Pack name" />
            <button
              className="btn btn-primary small"
              disabled={busy || !title.trim() || title.trim() === pack.title}
              onClick={() => void run(() => api.admin.renameStickerPack(pack.id, title.trim()), 'Renamed')}
            >
              Rename
            </button>
          </div>
          <p className="muted small">
            {pack.users ? `Added by ${pack.users} ${pack.users === 1 ? 'person' : 'people'}.` : 'Nobody has added it yet.'}
            {pack.stickers.length === 0 && ' People don’t see it until it has stickers.'}
          </p>
          <div className="admin-actions">
            <button className="chip-btn" disabled={busy || at <= 0} onClick={() => shift(-1)}>
              <ArrowUp size={16} /> Move up
            </button>
            <button className="chip-btn" disabled={busy || at >= data.packs.length - 1} onClick={() => shift(1)}>
              <ArrowDown size={16} /> Move down
            </button>
            <button className="chip-btn danger" disabled={busy} onClick={deletePack}>
              <Trash2 size={16} /> Delete pack
            </button>
          </div>
        </div>
      )}

      {shown.length > 0 ? (
        <>
          <div className="pick-row">
            <span className="muted small">{picked.length ? `${picked.length} picked` : 'Tap stickers to pick them'}</span>
            <button className="link-btn" onClick={() => setPicked(allPicked ? [] : shown.map((s) => s.id))}>
              {allPicked ? 'Pick none' : 'Pick all'}
            </button>
          </div>
          <div className="sticker-grid admin-stickers">
            {shown.map((s) => {
              const on = picked.includes(s.id);
              return (
                <button key={s.id} className={`sticker-cell ${on ? 'on' : ''}`} onClick={() => toggle(s.id)}>
                  <Sticker url={s.url} play="hover" />
                  {on && (
                    <span className="sticker-check">
                      <Check size={14} strokeWidth={3} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <p className="muted pad">
          {view === UNSORTED
            ? 'Nothing waiting here. Upload stickers to start.'
            : 'This pack is empty: upload stickers into it, or move some here from Unsorted.'}
        </p>
      )}

      {picked.length > 0 && (
        <div className="sticker-actions">
          <select className="field" value="" disabled={busy} onChange={(e) => void moveTo(e.target.value)}>
            <option value="">Move {picked.length} to…</option>
            {view !== UNSORTED && <option value="0">Unsorted</option>}
            {data.packs
              .filter((p) => p.id !== view)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            <option value="new">New pack…</option>
          </select>
          <button className="btn btn-ghost danger" disabled={busy} onClick={deletePicked}>
            <Trash2 size={18} /> Delete
          </button>
        </div>
      )}
    </>
  );
}
