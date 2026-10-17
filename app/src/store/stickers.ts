import { create } from 'zustand';
import { api, errorText } from '../lib/api';
import { socket } from '../lib/socket';
import type { StickerPack } from '../lib/types';
import { useConfig } from './config';
import { toast } from './toast';

// The sticker packs the admin made, and the ones you added (from Saved
// Messages) to send in chats.
interface StickersState {
  packs: StickerPack[];
  mine: number[]; // the packs you added, the latest first
  loaded: boolean;
  /** The packs sheet: closed (null), the list (pack null) or one pack. */
  sheet: { pack: number | null } | null;
}

const empty: StickersState = { packs: [], mine: [], loaded: false, sheet: null };

export const useStickers = create<StickersState>(() => empty);

export const resetStickers = () => useStickers.setState(empty, true);

let loading: Promise<void> | null = null;

export function loadStickers(): Promise<void> {
  if (!useConfig.getState().features.stickers) return Promise.resolve();
  loading ??= api
    .stickers()
    .then((r) => useStickers.setState({ ...r, loaded: true }))
    .catch(() => {})
    .finally(() => (loading = null));
  return loading;
}

/** Adds a pack to your stickers, or takes it away. */
export async function setPackAdded(pack: StickerPack, on: boolean) {
  const prev = useStickers.getState().mine;
  useStickers.setState({ mine: on ? [pack.id, ...prev.filter((id) => id !== pack.id)] : prev.filter((id) => id !== pack.id) });
  try {
    useStickers.setState({ mine: (on ? await api.addStickerPack(pack.id) : await api.removeStickerPack(pack.id)).mine });
    toast(on ? `“${pack.title}” added to your stickers` : `“${pack.title}” removed`);
  } catch (e) {
    useStickers.setState({ mine: prev });
    toast(errorText(e));
  }
}

/** Opens the packs sheet: the list, or one pack. */
export const showStickerPacks = (pack: number | null = null) => useStickers.setState({ sheet: { pack } });
export const closeStickerPacks = () => useStickers.setState({ sheet: null });

/** Opens the pack a sticker (from a message) belongs to. */
export async function showPackOf(stickerId?: number) {
  const find = () => useStickers.getState().packs.find((p) => p.stickers.some((s) => s.id === stickerId));
  if (!find()) await loadStickers();
  const pack = find();
  if (pack) showStickerPacks(pack.id);
  else toast('This sticker pack is no longer available');
}

socket.on('stickers', () => void loadStickers());
socket.on('hello', () => void loadStickers());
