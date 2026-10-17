import { Check, ChevronLeft, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { StickerPack } from '../lib/types';
import { closeStickerPacks, loadStickers, setPackAdded, useStickers } from '../store/stickers';
import Sticker from './Sticker';

/** The sticker packs sheet, opened from Saved Messages, the sticker panel or a sticker in a chat. */
export function StickerSheetHost() {
  const sheet = useStickers((s) => s.sheet);
  return sheet ? <StickerPacksSheet key={sheet.pack ?? 0} start={sheet.pack} /> : null;
}

function StickerPacksSheet({ start }: { start: number | null }) {
  const packs = useStickers((s) => s.packs);
  const mine = useStickers((s) => s.mine);
  const loaded = useStickers((s) => s.loaded);
  const [open, setOpen] = useState(start);
  const pack = open ? packs.find((p) => p.id === open) : undefined;

  useEffect(() => void loadStickers(), []);

  return (
    <div className="sheet-backdrop" onClick={closeStickerPacks}>
      <div className="sheet sticker-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          {pack && (
            <button className="icon-btn" onClick={() => setOpen(null)} aria-label="All sticker packs">
              <ChevronLeft size={24} />
            </button>
          )}
          <h3 dir="auto">{pack ? pack.title : 'Sticker packs'}</h3>
          <div className="spacer" />
          <button className="icon-btn" onClick={closeStickerPacks} aria-label="Close">
            <X size={22} />
          </button>
        </div>
        {pack ? (
          <>
            <div className="sticker-grid sheet-stickers">
              {pack.stickers.map((s) => (
                <div key={s.id} className="sticker-cell">
                  <Sticker url={s.url} play="hover" />
                </div>
              ))}
            </div>
            <div className="sheet-foot">
              <AddButton pack={pack} added={mine.includes(pack.id)} wide />
            </div>
          </>
        ) : !loaded ? (
          <p className="muted pad">Loading…</p>
        ) : packs.length === 0 ? (
          <p className="muted pad">No sticker packs yet. The admin adds them in the admin panel.</p>
        ) : (
          <>
            <p className="muted small pad">Add the packs you like to send their stickers in any chat. Tap a pack to see all of it.</p>
            {packs.map((p) => (
              <div key={p.id} className="pack-row" onClick={() => setOpen(p.id)}>
                <span className="pack-cover">
                  <Sticker url={p.stickers[0].url} size={46} play="hover" />
                </span>
                <div className="user-row-body">
                  <span className="user-name" dir="auto">
                    {p.title}
                  </span>
                  <span className="user-sub">
                    {p.stickers.length} sticker{p.stickers.length === 1 ? '' : 's'}
                  </span>
                </div>
                <AddButton pack={p} added={mine.includes(p.id)} />
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function AddButton({ pack, added, wide }: { pack: StickerPack; added: boolean; wide?: boolean }) {
  return (
    <button
      className={`btn small ${added ? 'btn-ghost' : 'btn-primary'} ${wide ? 'wide' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        void setPackAdded(pack, !added);
      }}
    >
      {added ? !wide && <Check size={17} /> : <Plus size={17} />}
      {added ? (wide ? 'Remove from my stickers' : 'Added') : wide ? `Add ${pack.stickers.length} stickers` : 'Add'}
    </button>
  );
}
