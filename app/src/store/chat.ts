import { create } from 'zustand';
import { api, errorText, PAGE_SIZE, type SendPayload } from '../lib/api';
import { uid } from '../lib/format';
import { notify } from '../lib/native';
import { clearChatNotification } from '../lib/push';
import { playMessage } from '../lib/sounds';
import { appVisible } from '../lib/visibility';
import type { Conversation, Message, MessageType, Sticker, User } from '../lib/types';
import { plainText, splitLongText } from '../lib/markdown';
import { showNotice } from './notice';
import { toast } from './toast';

interface Presence {
  online: boolean;
  lastSeen: number;
}

interface ChatState {
  me: number;
  loaded: boolean;
  conversations: Record<number, Conversation>;
  messages: Record<number, Message[] | undefined>;
  hasMore: Record<number, boolean>;
  presence: Record<number, Presence>;
  typing: Record<number, Record<number, { until: number; kind: string }>>; // conversation -> user
  activeId: number | null;
  forwardDrafts: Record<number, Message>; // conversation -> a message waiting above its composer to be forwarded there
}

const initial: ChatState = {
  me: 0,
  loaded: false,
  conversations: {},
  messages: {},
  hasMore: {},
  presence: {},
  typing: {},
  activeId: null,
  forwardDrafts: {},
};

export const useChat = create<ChatState>(() => initial);
const get = useChat.getState;
const set = useChat.setState;

export const resetChat = () => set(initial, true);

// ---------- helpers ----------

export const peerOf = (c: Conversation, me: number) => c.members.find((m) => m.id !== me) ?? c.members[0];

export function titleOf(c: Conversation, me: number): string {
  if (c.type === 'group') return c.title;
  if (c.type === 'saved') return 'Saved Messages';
  return peerOf(c, me)?.name ?? 'Chat';
}

export const activityOf = (c: Conversation) => c.lastMessage?.createdAt ?? c.createdAt;

/** Whether uid runs this group. */
export const isGroupAdmin = (c: Conversation, uid: number) => c.type === 'group' && !!c.admins?.includes(uid);

export function previewOf(m: Pick<Message, 'type' | 'body' | 'fileName'> | null | undefined): string {
  if (!m) return '';
  switch (m.type) {
    case 'image':
      return m.body ? `📷 ${m.body}` : '📷 Photo';
    case 'video':
      return m.body ? `🎬 ${m.body}` : '🎬 Video';
    case 'audio':
      return '🎤 Voice message';
    case 'file':
      return `📎 ${m.fileName || 'File'}`;
    case 'sticker':
      return 'Sticker';
    case 'deleted':
      return '🚫 Message deleted';
  }
  return plainText(m.body);
}

export function nameOf(userId: number, conv?: Conversation): string {
  if (userId === get().me) return 'You';
  return conv?.members.find((m) => m.id === userId)?.name ?? 'Someone';
}

function presenceFrom(users: User[], into: Record<number, Presence>) {
  const out = { ...into };
  for (const u of users) out[u.id] = { online: u.online, lastSeen: u.lastSeen };
  return out;
}

// A message an older server deleted for everyone: emptied, typed "deleted".
// It's gone, like the ones today's server simply takes away.
const wiped = (m: Message) => m.type === 'deleted';

const isViewing = (convId: number) => get().activeId === convId && appVisible();

function upsert(list: Message[], msg: Message): Message[] {
  const i = list.findIndex((m) => (msg.id && m.id === msg.id) || (msg.clientId && m.clientId === msg.clientId));
  const next = list.slice();
  if (i >= 0) next[i] = { ...msg, localUrl: list[i].localUrl };
  else next.push(msg);
  // Confirmed messages in id order, anything still sending at the end.
  return next.sort((a, b) => (a.id || Number.MAX_SAFE_INTEGER) - (b.id || Number.MAX_SAFE_INTEGER));
}

function putConversation(c: Conversation) {
  set((s) => ({
    conversations: { ...s.conversations, [c.id]: c },
    presence: presenceFrom(c.members, s.presence),
  }));
}

function patchConversation(id: number, patch: Partial<Conversation>) {
  set((s) => {
    const c = s.conversations[id];
    return c ? { conversations: { ...s.conversations, [id]: { ...c, ...patch } } } : {};
  });
}

// ---------- loading ----------

export async function loadConversations() {
  const list = await api.conversations();
  set((s) => {
    let presence = s.presence;
    const conversations: Record<number, Conversation> = {};
    for (const c of list) {
      const prev = s.conversations[c.id];
      if (prev?.lastMessage && !prev.lastMessage.id) c.lastMessage = prev.lastMessage; // keep optimistic preview
      conversations[c.id] = c;
      presence = presenceFrom(c.members, presence);
    }
    // Opened-but-empty chats aren't listed by the server; keep them.
    for (const [id, c] of Object.entries(s.conversations)) if (!conversations[+id]) conversations[+id] = c;
    return { conversations, presence, loaded: true };
  });
}

const inflight = new Map<number, Promise<Conversation | null>>();

export function ensureConversation(id: number, refresh = false): Promise<Conversation | null> {
  const known = get().conversations[id];
  if (known && !refresh) return Promise.resolve(known);
  let p = inflight.get(id);
  if (!p) {
    p = api
      .conversation(id)
      .then((c) => {
        putConversation(c);
        return c;
      })
      .catch(() => null)
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

export const addConversation = putConversation;

export async function loadMessages(convId: number) {
  const page = await api.messages(convId);
  const msgs = page.filter((m) => !wiped(m));
  set((s) => {
    let list = msgs;
    for (const m of s.messages[convId] ?? []) if (!m.id) list = upsert(list, m); // keep unsent ones
    return {
      messages: { ...s.messages, [convId]: list },
      hasMore: { ...s.hasMore, [convId]: page.length >= PAGE_SIZE },
    };
  });
}

export async function loadOlder(convId: number) {
  const current = get().messages[convId] ?? [];
  const first = current.find((m) => m.id > 0);
  if (!first) return;
  const older = await api.messages(convId, first.id);
  set((s) => ({
    messages: { ...s.messages, [convId]: [...older.filter((m) => !wiped(m)), ...(s.messages[convId] ?? [])] },
    hasMore: { ...s.hasMore, [convId]: older.length >= PAGE_SIZE },
  }));
}

// ---------- incoming events ----------

export function receiveMessage(msg: Message) {
  const s = get();
  const conv = s.conversations[msg.conversationId];
  if (!conv) {
    // A chat we haven't seen yet (someone wrote to us first).
    void ensureConversation(msg.conversationId).then((c) => {
      if (c && msg.senderId !== get().me) announce(c, msg);
    });
    return;
  }
  const fromOther = msg.senderId !== s.me;
  const alreadyCounted = (conv.lastMessage?.id ?? 0) >= msg.id && msg.id > 0;
  const viewing = isViewing(conv.id);
  const newer = !conv.lastMessage || !conv.lastMessage.id || conv.lastMessage.id <= msg.id || !msg.id;

  set((st) => ({
    conversations: {
      ...st.conversations,
      [conv.id]: {
        ...conv,
        lastMessage: newer ? msg : conv.lastMessage,
        unread: fromOther && !alreadyCounted && !viewing ? conv.unread + 1 : conv.unread,
      },
    },
    messages: st.messages[conv.id] ? { ...st.messages, [conv.id]: upsert(st.messages[conv.id]!, msg) } : st.messages,
  }));

  if (fromOther && !alreadyCounted) {
    if (viewing) markRead(conv.id);
    else announce(conv, msg);
  }
}

/** An edited / reacted message, or (for admins) one deleted for everyone. */
export function updateMessage(msg: Message) {
  if (wiped(msg)) return hideMessage({ conversationId: msg.conversationId, id: msg.id, deleted: true });
  const quote = msg.deletedAt ? { type: 'deleted' as const, body: '' } : { type: msg.type, body: msg.body };
  set((s) => {
    const conv = s.conversations[msg.conversationId];
    const list = s.messages[msg.conversationId];
    const patch: Partial<ChatState> = {};
    if (list) {
      patch.messages = {
        ...s.messages,
        [msg.conversationId]: list.map((m) => (m.id === msg.id ? { ...msg, localUrl: m.localUrl } : m.reply?.id === msg.id ? { ...m, reply: { ...m.reply, ...quote } } : m)),
      };
    }
    if (conv) {
      patch.conversations = {
        ...s.conversations,
        [conv.id]: {
          ...conv,
          lastMessage: conv.lastMessage?.id === msg.id ? msg : conv.lastMessage,
          pinned: conv.pinned?.id === msg.id ? (msg.deletedAt ? null : msg) : conv.pinned,
          pins: conv.pins?.flatMap((p) => (p.id !== msg.id ? [p] : msg.deletedAt ? [] : [msg])),
        },
      };
    }
    return patch;
  });
}

/** A message gone from this chat: deleted for me, or (deleted) for everyone. */
export function hideMessage(d: { conversationId: number; id: number; deleted?: boolean }) {
  set((s) => {
    const list = s.messages[d.conversationId];
    if (!list) return {};
    const kept = list.filter((m) => m.id !== d.id);
    return {
      messages: {
        ...s.messages,
        [d.conversationId]: d.deleted
          ? kept.map((m) => (m.reply?.id === d.id ? { ...m, reply: { ...m.reply, type: 'deleted', body: '' } } : m))
          : kept,
      },
    };
  });
  if (get().conversations[d.conversationId]?.lastMessage?.id === d.id) void ensureConversation(d.conversationId, true);
}

export function setPinned(d: { conversationId: number; pinned: Message | null; pins?: Message[] }) {
  patchConversation(d.conversationId, { pinned: d.pinned, pins: d.pins ?? (d.pinned ? [d.pinned] : []) });
}

/** A chat's pinned messages, oldest first. */
export const pinsOf = (c?: Conversation): Message[] => c?.pins ?? (c?.pinned ? [c.pinned] : []);

/** A message from a chat that isn't on screen: a sound and the banner if the app is in front, else a notification. */
function announce(c: Conversation, msg: Message) {
  if (c.muted) return;
  const sender = c.members.find((m) => m.id === msg.senderId);
  const title = c.type === 'group' ? `${sender?.name ?? 'Someone'} · ${c.title}` : (sender?.name ?? 'New message');
  if (appVisible()) {
    playMessage();
    showNotice(msg);
  }
  notify(title, previewOf(msg));
}

export function applyRead(d: { conversationId: number; userId: number; messageId: number }) {
  const conv = get().conversations[d.conversationId];
  if (!conv) return;
  const key = String(d.userId);
  const reads = { ...conv.reads, [key]: Math.max(conv.reads[key] ?? 0, d.messageId) };
  let unread = conv.unread;
  if (d.userId === get().me && conv.lastMessage && d.messageId >= conv.lastMessage.id) unread = 0;
  patchConversation(conv.id, { reads, unread });
}

/** The chat is on screen: its messages are seen and its notification can go. */
export function markRead(convId: number) {
  clearChatNotification(convId);
  const s = get();
  const conv = s.conversations[convId];
  const last = conv?.lastMessage;
  if (!conv || !last?.id) return;
  const key = String(s.me);
  if (conv.unread === 0 && (conv.reads[key] ?? 0) >= last.id) return;
  patchConversation(convId, { unread: 0, reads: { ...conv.reads, [key]: last.id } });
  api.read(convId, last.id).catch(() => {});
}

export function setPresence(userId: number, online: boolean, lastSeen?: number) {
  set((s) => ({
    presence: { ...s.presence, [userId]: { online, lastSeen: lastSeen ?? s.presence[userId]?.lastSeen ?? 0 } },
  }));
}

export function setOnlineList(ids: number[]) {
  const online = new Set(ids);
  set((s) => {
    const presence: Record<number, Presence> = {};
    for (const [id, p] of Object.entries(s.presence)) presence[+id] = { ...p, online: online.has(+id) };
    for (const id of ids) presence[id] ??= { online: true, lastSeen: 0 };
    return { presence };
  });
}

const typingTimers = new Map<string, number>();

export function setTyping(convId: number, userId: number, kind = 'typing') {
  const until = Date.now() + 4000;
  set((s) => ({ typing: { ...s.typing, [convId]: { ...s.typing[convId], [userId]: { until, kind } } } }));
  const key = `${convId}:${userId}`;
  clearTimeout(typingTimers.get(key));
  typingTimers.set(key, window.setTimeout(() => clearTyping(convId, userId), 4100));
}

function clearTyping(convId: number, userId: number) {
  set((s) => {
    const forConv = { ...s.typing[convId] };
    delete forConv[userId];
    return { typing: { ...s.typing, [convId]: forConv } };
  });
}

export function upsertUser(u: User) {
  set((s) => {
    const conversations = { ...s.conversations };
    for (const c of Object.values(conversations)) {
      if (c.members.some((m) => m.id === u.id)) {
        conversations[c.id] = { ...c, members: c.members.map((m) => (m.id === u.id ? { ...m, ...u, phone: m.phone } : m)) };
      }
    }
    return { conversations, presence: presenceFrom([u], s.presence) };
  });
}

// ---------- sending ----------

export interface Draft {
  type: Exclude<MessageType, 'deleted'>;
  body?: string;
  file?: Blob;
  fileName?: string;
  duration?: number;
  sticker?: Sticker;
  replyTo?: Message | null;
}

const drafts = new Map<string, Draft>(); // clientId -> what to resend

export function sendMessage(convId: number, draft: Draft) {
  void deliver(convId, queue(convId, draft));
}

/**
 * A text too long for one message, in several (see splitLongText), sent one
 * after another so they arrive in order; if one fails, the rest wait as
 * failed too, to retry.
 */
export function sendTexts(convId: number, bodies: string[], replyTo?: Message) {
  const ids = bodies.map((body, i) => queue(convId, { type: 'text', body, replyTo: i ? undefined : replyTo }));
  void (async () => {
    for (let i = 0; i < ids.length; i++) {
      if (!(await deliver(convId, ids[i]))) {
        for (const rest of ids.slice(i + 1)) patchPending(convId, rest, { status: 'failed' });
        return;
      }
    }
  })();
}

/** Shows the message as sending; deliver() then sends it. */
function queue(convId: number, draft: Draft): string {
  const clientId = uid();
  drafts.set(clientId, draft);
  const r = draft.replyTo;
  const pending: Message = {
    id: 0,
    conversationId: convId,
    senderId: get().me,
    type: draft.type,
    body: draft.body ?? '',
    duration: draft.duration,
    fileName: draft.fileName,
    fileSize: draft.file?.size,
    mediaUrl: draft.sticker?.url,
    stickerId: draft.sticker?.id,
    reply: r ? { id: r.id, senderId: r.senderId, type: r.type, body: r.body } : undefined,
    clientId,
    createdAt: Date.now(),
    status: 'sending',
    localUrl: draft.file ? URL.createObjectURL(draft.file) : undefined,
    progress: draft.file ? 0 : undefined,
  };
  set((s) => {
    const conv = s.conversations[convId];
    return {
      messages: { ...s.messages, [convId]: upsert(s.messages[convId] ?? [], pending) },
      conversations: conv ? { ...s.conversations, [convId]: { ...conv, lastMessage: pending } } : s.conversations,
    };
  });
  return clientId;
}

export function retryMessage(convId: number, clientId: string) {
  patchPending(convId, clientId, { status: 'sending' });
  void deliver(convId, clientId);
}

export function discardMessage(convId: number, clientId: string) {
  drafts.delete(clientId);
  set((s) => ({
    messages: { ...s.messages, [convId]: (s.messages[convId] ?? []).filter((m) => m.clientId !== clientId) },
  }));
}

function patchPending(convId: number, clientId: string, patch: Partial<Message>) {
  set((s) => ({
    messages: {
      ...s.messages,
      [convId]: (s.messages[convId] ?? []).map((m) => (m.clientId === clientId && !m.id ? { ...m, ...patch } : m)),
    },
  }));
}

/** Sends a queued message; whether it went. */
async function deliver(convId: number, clientId: string): Promise<boolean> {
  const draft = drafts.get(clientId);
  if (!draft) return false;
  try {
    const payload: SendPayload = {
      type: draft.type,
      body: draft.body,
      duration: draft.duration,
      stickerId: draft.sticker?.id,
      clientId,
      replyTo: draft.replyTo?.id || undefined,
    };
    if (draft.file) {
      let last = 0;
      const up = await api.upload(draft.file, draft.fileName ?? 'file', (p) => {
        if (p - last > 0.04 || p === 1) {
          last = p;
          patchPending(convId, clientId, { progress: p });
        }
      });
      payload.mediaUrl = up.url;
      payload.fileName = draft.fileName ?? up.name;
      payload.fileSize = up.size;
    }
    const saved = await api.send(convId, payload);
    drafts.delete(clientId);
    receiveMessage(saved);
    return true;
  } catch (e) {
    patchPending(convId, clientId, { status: 'failed' });
    toast(errorText(e));
    return false;
  }
}

// ---------- message actions ----------

export async function editMessage(msg: Message, body: string) {
  const prev = msg;
  updateMessage({ ...msg, body, editedAt: Date.now() });
  try {
    updateMessage(await api.editMessage(msg.id, body));
  } catch (e) {
    updateMessage(prev);
    toast(errorText(e));
  }
}

export async function deleteMessage(msg: Message, forAll: boolean) {
  if (!msg.id) {
    if (msg.clientId) discardMessage(msg.conversationId, msg.clientId);
    return;
  }
  try {
    await api.deleteMessage(msg.id, forAll);
    hideMessage({ conversationId: msg.conversationId, id: msg.id, deleted: forAll });
  } catch (e) {
    toast(errorText(e));
  }
}

/** Ticks or unticks item n of a checklist in msg. */
export async function checkItem(msg: Message, item: number, on: boolean) {
  updateMessage({ ...msg, checks: { ...msg.checks, [item]: { on, by: get().me, at: Date.now() } } });
  try {
    updateMessage(await api.check(msg.id, item, on));
  } catch (e) {
    updateMessage(msg);
    toast(errorText(e));
  }
}

export async function reactTo(msg: Message, emoji: string) {
  const me = get().me;
  const next: Record<string, number[]> = {};
  let had = '';
  for (const [e, users] of Object.entries(msg.reactions ?? {})) {
    if (users.includes(me)) had = e;
    const kept = users.filter((u) => u !== me);
    if (kept.length) next[e] = kept;
  }
  if (had !== emoji) next[emoji] = [...(next[emoji] ?? []), me];
  updateMessage({ ...msg, reactions: next });
  try {
    updateMessage(await api.react(msg.id, emoji));
  } catch (e) {
    updateMessage(msg);
    toast(errorText(e));
  }
}

export async function forwardMessage(msg: Message, conversationIds: number[]) {
  const sent = await api.forward(msg.id, conversationIds);
  sent.forEach(receiveMessage);
  return sent;
}

/** Forwards msg to the chats, each after the comment written with it (if any). */
export async function forwardWithComment(msg: Message, conversationIds: number[], comment = '') {
  const body = comment.trim();
  if (body) {
    for (const id of conversationIds) {
      for (const part of splitLongText(body)) receiveMessage(await api.send(id, { type: 'text', body: part, clientId: uid() }));
    }
  }
  return forwardMessage(msg, conversationIds);
}

/**
 * Answers from the banner: sends the text (in several messages if it's
 * long) and marks the chat read. Throws if it couldn't be sent.
 */
export async function quickReply(convId: number, body: string, replyTo?: Message) {
  const parts = splitLongText(body);
  for (let i = 0; i < parts.length; i++) {
    receiveMessage(await api.send(convId, { type: 'text', body: parts[i], clientId: uid(), replyTo: i ? undefined : replyTo?.id }));
  }
  markRead(convId);
}

/** Puts a message above a chat's composer, to forward when Send is pressed (null takes it away). */
export function setForwardDraft(conversationId: number, msg: Message | null) {
  set((s) => {
    const forwardDrafts = { ...s.forwardDrafts };
    if (msg) forwardDrafts[conversationId] = msg;
    else delete forwardDrafts[conversationId];
    return { forwardDrafts };
  });
}

/** Your Saved Messages chat (made on first use). */
export async function openSaved(): Promise<Conversation> {
  const c = await api.savedMessages();
  putConversation(c);
  return c;
}

/** Drop a chat from this device (history cleared, group left). */
export function removeConversation(id: number) {
  set((s) => {
    const conversations = { ...s.conversations };
    const messages = { ...s.messages };
    delete conversations[id];
    delete messages[id];
    return { conversations, messages };
  });
}

export async function setMuted(convId: number, muted: boolean) {
  patchConversation(convId, { muted });
  try {
    await api.mute(convId, muted);
  } catch (e) {
    patchConversation(convId, { muted: !muted });
    toast(errorText(e));
  }
}

export async function setBlocked(convId: number, userId: number, blocked: boolean) {
  try {
    await (blocked ? api.block(userId) : api.unblock(userId));
    patchConversation(convId, { blocked });
    toast(blocked ? 'User blocked' : 'User unblocked');
  } catch (e) {
    toast(errorText(e));
  }
}

/** Pins msg (on) or takes it out of the chat's pins. */
export async function pinMessage(convId: number, msg: Message, on: boolean) {
  const conv = get().conversations[convId];
  const prev = pinsOf(conv);
  const next = prev.filter((p) => p.id !== msg.id);
  if (on) next.push(msg);
  next.sort((a, b) => a.id - b.id);
  const show = (pins: Message[]) => setPinned({ conversationId: convId, pinned: pins[pins.length - 1] ?? null, pins });
  show(next);
  try {
    await api.pin(convId, msg.id, !on);
  } catch (e) {
    show(prev);
    toast(errorText(e));
  }
}
