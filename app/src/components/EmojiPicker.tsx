import { Plus, Smile, Sticker as StickerIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { storage } from '../lib/config';
import type { Sticker as StickerData } from '../lib/types';
import { showStickerPacks, useStickers } from '../store/stickers';
import Sticker from './Sticker';

const GROUPS: [string, string][] = [
  ['Smileys', '😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫣 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕'],
  ['Hearts', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ✨ 🌟 ⭐ 🔥 💫'],
  ['Hands', '👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👋 🤚 🖐️ ✋ 👏 🙌 🫶 👐 🤲 🙏 💪'],
  ['Nature', '🌸 🌺 🌼 🌻 🌷 🌹 🥀 💐 🌙 🌛 🌜 🌝 ☀️ 🌤️ ⛅ 🌈 ☁️ 🌧️ ⚡ ❄️ 🌊 🌿 🍀 🍁 🐱 🐶 🐰 🦊 🐻 🐼 🐨 🦋'],
  ['Things', '☕ 🍵 🍰 🎂 🍕 🍔 🍟 🍿 🍩 🍪 🍫 🍓 🍉 🍎 🎉 🎊 🎁 🎈 📷 🎵 🎶 🎮 ⚽ 🏀 📚 ✏️ 💼 💻 📱 ⏰ 🚗 ✈️ 🏠'],
];

const TAB = 'chaty.panelTab';

/** Emoji, and with onSticker the stickers of the packs you added (the tab you used last opens). */
export default function EmojiPicker({ onPick, onSticker }: { onPick: (emoji: string) => void; onSticker?: (s: StickerData) => void }) {
  const [tab, setTab] = useState(() => (storage.get(TAB) === 'stickers' ? 'stickers' : 'emoji'));
  const pick = (t: 'emoji' | 'stickers') => {
    setTab(t);
    storage.set(TAB, t);
  };
  const stickers = onSticker && tab === 'stickers';
  return (
    <div className={`emoji-panel ${onSticker ? 'tabbed' : ''}`}>
      {onSticker && (
        <div className="panel-tabs">
          <button className={tab === 'emoji' ? 'on' : ''} onClick={() => pick('emoji')}>
            <Smile size={17} /> Emoji
          </button>
          <button className={tab === 'stickers' ? 'on' : ''} onClick={() => pick('stickers')}>
            <StickerIcon size={17} /> Stickers
          </button>
        </div>
      )}
      {stickers ? (
        <StickerPicker onPick={onSticker} />
      ) : (
        <div className="panel-scroll">
          {GROUPS.map(([label, list]) => (
            <section key={label}>
              <h4>{label}</h4>
              <div className="emoji-grid">
                {list.split(' ').map((e) => (
                  <button key={e} type="button" onClick={() => onPick(e)}>
                    {e}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** The packs you added, one section each, with a strip of their covers to jump between them. */
function StickerPicker({ onPick }: { onPick: (s: StickerData) => void }) {
  const packs = useStickers((s) => s.packs);
  const mine = useStickers((s) => s.mine);
  const loaded = useStickers((s) => s.loaded);
  const scroller = useRef<HTMLDivElement>(null);
  const added = useMemo(() => mine.flatMap((id) => packs.filter((p) => p.id === id)), [packs, mine]);

  const jump = (id: number) =>
    scroller.current?.querySelector(`[data-pack="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  if (!added.length) {
    return (
      <div className="panel-scroll sticker-empty">
        <p className="muted">{loaded ? 'No stickers yet.' : 'Loading…'}</p>
        {loaded && (
          <button className="btn btn-primary small" onClick={() => showStickerPacks()}>
            <Plus size={17} /> Add sticker packs
          </button>
        )}
      </div>
    );
  }
  return (
    <>
      <div className="sticker-strip">
        {added.map((p) => (
          <button key={p.id} onClick={() => jump(p.id)} aria-label={p.title} title={p.title}>
            <Sticker url={p.stickers[0].url} size={30} play="hover" />
          </button>
        ))}
        <button className="sticker-strip-add" onClick={() => showStickerPacks()} aria-label="Sticker packs" title="Sticker packs">
          <Plus size={20} />
        </button>
      </div>
      <div className="panel-scroll" ref={scroller}>
        {added.map((p) => (
          <section key={p.id} data-pack={p.id}>
            <h4 dir="auto">{p.title}</h4>
            <div className="sticker-grid">
              {p.stickers.map((s) => (
                <button key={s.id} type="button" className="sticker-cell" onClick={() => onPick(s)}>
                  <Sticker url={s.url} play="hover" />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
