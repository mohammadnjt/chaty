import { create } from 'zustand';
import { api, ApiError, setApiToken, setUnauthorizedHandler, type AuthResponse } from '../lib/api';
import { isNativeShell, needsServerUrl, storage } from '../lib/config';
import { askPermissions } from '../lib/native';
import { disablePush, enablePush } from '../lib/push';
import { navigate } from '../lib/router';
import { socket } from '../lib/socket';
import type { Message, User } from '../lib/types';
import {
  addConversation,
  applyRead,
  hideMessage,
  loadConversations,
  loadMessages,
  receiveMessage,
  removeConversation,
  resetChat,
  setOnlineList,
  setPinned,
  setPresence,
  setTyping,
  updateMessage,
  upsertUser,
  useChat,
} from './chat';
import { loadConfig } from './config';
import { resetStories } from './stories';
import { toast } from './toast';

interface AuthState {
  status: 'loading' | 'guest' | 'ready';
  me: User | null;
  pendingCount: number; // sign-ups waiting for an admin
}

export const useAuth = create<AuthState>(() => ({ status: 'loading', me: null, pendingCount: 0 }));

const TOKEN = 'chaty.token';
const ME = 'chaty.me';

function signedIn(token: string, me: User) {
  storage.set(TOKEN, token);
  storage.set(ME, JSON.stringify(me));
  setApiToken(token);
  useChat.setState({ me: me.id });
  useAuth.setState({ status: 'ready', me });
  socket.connect(token);
  void loadConfig();
  void (async () => {
    // The Android app asks once, up front, for what calls and notifications
    // need, so the first call doesn't stop for Android's prompts.
    if (isNativeShell && !storage.get('chaty.askedPermissions')) {
      storage.set('chaty.askedPermissions', '1');
      await askPermissions('RECORD_AUDIO,CAMERA,POST_NOTIFICATIONS');
    }
    // Keep this device's push registration fresh (browsers don't prompt here).
    await enablePush(false).catch(() => false);
  })();
  loadConversations().catch(() => {});
  if (me.role === 'admin') refreshPendingCount();
}

export function refreshPendingCount() {
  api.admin
    .users()
    .then((users) => useAuth.setState({ pendingCount: users.filter((u) => u.status === 'pending').length }))
    .catch(() => {});
}

export async function initAuth() {
  const token = storage.get(TOKEN);
  if (!token || needsServerUrl()) {
    useAuth.setState({ status: 'guest' });
    return;
  }
  setApiToken(token);
  try {
    signedIn(token, await api.me());
  } catch (e) {
    const cached = storage.get(ME);
    if (e instanceof ApiError && e.status === 401) {
      clearSession();
    } else if (cached) {
      // Server unreachable right now: open with what we know and keep retrying.
      signedIn(token, JSON.parse(cached) as User);
    } else {
      useAuth.setState({ status: 'guest' });
    }
  }
}

export async function login(phone: string, password: string) {
  const r: AuthResponse = await api.login(phone, password);
  signedIn(r.token, r.user);
}

/** Returns true when the account still needs an admin's approval. */
export async function register(phone: string, name: string, password: string): Promise<boolean> {
  const r = await api.register(phone, name, password);
  if ('pending' in r) return true;
  signedIn(r.token, r.user);
  return false;
}

function clearSession() {
  socket.disconnect();
  storage.remove(TOKEN);
  storage.remove(ME);
  setApiToken(null);
  resetChat();
  resetStories();
  useAuth.setState({ status: 'guest', me: null, pendingCount: 0 });
  navigate('/', { replace: true });
}

export async function logout() {
  await disablePush();
  await api.logout().catch(() => {});
  clearSession();
}

export async function updateProfile(
  patch: Partial<Pick<User, 'name' | 'about' | 'avatar' | 'username' | 'hidePhoneSearch' | 'hideLastSeen'>>,
) {
  const me = await api.updateMe(patch);
  storage.set(ME, JSON.stringify(me));
  useAuth.setState({ me });
}

setUnauthorizedHandler(() => {
  if (useAuth.getState().status === 'ready') clearSession();
});

// ---------- realtime events ----------

socket.on('hello', (d: { online: number[] }) => {
  setOnlineList(d.online ?? []);
  // Catch up on anything that happened while we were disconnected.
  loadConversations().catch(() => {});
  void loadConfig();
  const active = useChat.getState().activeId;
  if (active) loadMessages(active).catch(() => {});
});
socket.on('message', receiveMessage);
socket.on('message:update', updateMessage);
socket.on('message:hide', hideMessage);
socket.on('pin', (d: { conversationId: number; pinned: Message | null }) => setPinned(d));
socket.on('read', applyRead);
socket.on('typing', (d: { conversationId: number; userId: number; kind?: string }) =>
  setTyping(d.conversationId, d.userId, d.kind),
);
socket.on('presence', (d: { userId: number; online: boolean; lastSeen?: number }) =>
  setPresence(d.userId, d.online, d.lastSeen),
);
socket.on('conversation', addConversation);
socket.on('conversation:cleared', (d: { conversationId: number }) => removeConversation(d.conversationId));
socket.on('conversation:left', (d: { conversationId: number }) => removeConversation(d.conversationId));
// Blocking someone changes how both chats look; just reload.
socket.on('block', () => loadConversations().catch(() => {}));
socket.on('user', (u: User) => {
  const me = useAuth.getState().me;
  if (u.id === me?.id) {
    const next = { ...me, ...u };
    storage.set(ME, JSON.stringify(next));
    useAuth.setState({ me: next });
  } else {
    upsertUser(u);
  }
});
socket.on('admin:pending', (u: User) => {
  useAuth.setState((s) => ({ pendingCount: s.pendingCount + 1 }));
  toast(`${u.name} is waiting for approval`);
});
