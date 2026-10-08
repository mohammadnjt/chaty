import { create } from 'zustand';
import { api } from '../lib/api';
import { socket } from '../lib/socket';
import type { AppConfig } from '../lib/types';

// Features and call settings chosen by the admin. Everything is on until the
// server says otherwise.
const defaults: AppConfig = {
  appName: 'Chaty',
  maxUploadMB: 50,
  features: {
    voiceCalls: true,
    videoCalls: true,
    groups: true,
    photos: true,
    files: true,
    voiceMessages: true,
    editMessages: true,
    deleteMessages: true,
    reactions: true,
    forwarding: true,
  },
  calls: { mode: 'auto', p2pTimeoutSec: 12, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
};

export const useConfig = create<AppConfig>(() => defaults);

export async function loadConfig() {
  try {
    useConfig.setState(await api.config());
  } catch {
    /* keep the last known config */
  }
}

socket.on('config', (c: AppConfig) => useConfig.setState(c));
