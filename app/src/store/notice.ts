import { create } from 'zustand';
import { storage } from '../lib/config';
import { getPath } from '../lib/router';
import type { Message } from '../lib/types';

// The banner at the top of the screen for a message from another chat that
// comes in while Chaty is open (no push needed: the app has it already).
export interface Notice {
  conversationId: number;
  message: Message; // the latest one
  count: number; // how many came in while it's been up
  shownAt: number;
}

interface NoticeState {
  notice: Notice | null;
  replying: boolean;
}

export const useNotice = create<NoticeState>(() => ({ notice: null, replying: false }));

const OFF = 'chaty.bannersOff';

/** Banners are on unless turned off in Settings (per device). */
export const bannersOn = () => !storage.get(OFF);
export const setBannersOn = (on: boolean) => (on ? storage.remove(OFF) : storage.set(OFF, '1'));

/**
 * Shows msg in the banner, unless the chat list is on screen (it shows the
 * message there). While a quick reply is being written, only messages of
 * that chat update the banner.
 */
export function showNotice(msg: Message) {
  if (!bannersOn() || getPath() === '/') return;
  const { notice, replying } = useNotice.getState();
  const same = notice?.conversationId === msg.conversationId;
  if (replying && !same) return;
  useNotice.setState({
    notice: { conversationId: msg.conversationId, message: msg, count: same ? notice!.count + 1 : 1, shownAt: Date.now() },
  });
}

export const dismissNotice = () => useNotice.setState({ notice: null, replying: false });
