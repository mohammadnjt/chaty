import { apiUrl } from './config';
import type { AdminOverview, AppConfig, CallRecord, Conversation, Message, MessageType, Settings, User } from './types';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export const setApiToken = (t: string | null) => (token = t);
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

function capitalize(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(apiUrl(path), { method, headers, body: payload });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token && onUnauthorized) onUnauthorized();
    throw new ApiError(capitalize(data?.error || `Request failed (${res.status})`), res.status, data?.code);
  }
  return data as T;
}

/** Upload with progress (fetch can't report upload progress). */
function uploadWithProgress(file: Blob, filename: string, onProgress?: (p: number) => void) {
  return new Promise<{ url: string; name: string; size: number }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/api/upload'));
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(capitalize(data?.error || `Upload failed (${xhr.status})`), xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("Can't reach the server. Check your connection.", 0));
    const form = new FormData();
    form.append('file', file, filename);
    xhr.send(form);
  });
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface SendPayload {
  type: MessageType;
  body?: string;
  mediaUrl?: string;
  fileName?: string;
  fileSize?: number;
  duration?: number;
  clientId?: string;
  replyTo?: number;
}

export interface PublicConfig {
  appName: string;
  registrationOpen: boolean;
  requireApproval: boolean;
}

export const PAGE_SIZE = 60;

export const api = {
  health: () => request<{ ok: boolean }>('GET', '/api/health'),
  publicConfig: () => request<PublicConfig>('GET', '/api/public-config'),
  register: (phone: string, name: string, password: string) =>
    request<AuthResponse | { pending: true }>('POST', '/api/auth/register', { phone, name, password }),
  login: (phone: string, password: string) => request<AuthResponse>('POST', '/api/auth/login', { phone, password }),
  logout: () => request('POST', '/api/auth/logout'),
  me: () => request<User>('GET', '/api/me'),
  updateMe: (patch: Partial<Pick<User, 'name' | 'about' | 'avatar' | 'username' | 'hidePhoneSearch' | 'hideLastSeen'>>) =>
    request<User>('PATCH', '/api/me', patch),
  changePassword: (current: string, next: string) => request('POST', '/api/me/password', { current, next }),
  config: () => request<AppConfig>('GET', '/api/config'),
  users: (q = '') => request<User[]>('GET', '/api/users?q=' + encodeURIComponent(q)),
  conversations: () => request<Conversation[]>('GET', '/api/conversations'),
  conversation: (id: number) => request<Conversation>('GET', `/api/conversations/${id}`),
  /** query = the phone number / @ID used to find someone new */
  openDirect: (userId: number, query = '') => request<Conversation>('POST', '/api/conversations/direct', { userId, query }),
  createGroup: (title: string, memberIds: number[], queries: Record<number, string> = {}) =>
    request<Conversation>('POST', '/api/conversations/group', { title, memberIds, queries }),
  blocks: () => request<User[]>('GET', '/api/blocks'),
  block: (userId: number) => request('POST', `/api/users/${userId}/block`),
  unblock: (userId: number) => request('DELETE', `/api/users/${userId}/block`),
  mute: (id: number, muted: boolean) => request('POST', `/api/conversations/${id}/mute`, { muted }),
  clearHistory: (id: number) => request('POST', `/api/conversations/${id}/clear`),
  leaveGroup: (id: number) => request('POST', `/api/conversations/${id}/leave`),
  messages: (id: number, before = 0) =>
    request<Message[]>('GET', `/api/conversations/${id}/messages?before=${before}&limit=${PAGE_SIZE}`),
  send: (id: number, p: SendPayload) => request<Message>('POST', `/api/conversations/${id}/messages`, p),
  read: (id: number, messageId: number) => request('POST', `/api/conversations/${id}/read`, { messageId }),
  pin: (id: number, messageId: number) => request('POST', `/api/conversations/${id}/pin`, { messageId }),
  editMessage: (id: number, body: string) => request<Message>('PATCH', `/api/messages/${id}`, { body }),
  deleteMessage: (id: number, forAll: boolean) => request('DELETE', `/api/messages/${id}?for=${forAll ? 'all' : 'me'}`),
  react: (id: number, emoji: string) => request<Message>('POST', `/api/messages/${id}/react`, { emoji }),
  forward: (id: number, conversationIds: number[]) =>
    request<Message[]>('POST', `/api/messages/${id}/forward`, { conversationIds }),
  calls: () => request<CallRecord[]>('GET', '/api/calls'),
  upload: uploadWithProgress,
  admin: {
    overview: () => request<AdminOverview>('GET', '/api/admin/overview'),
    users: () => request<User[]>('GET', '/api/admin/users'),
    userAction: (id: number, action: 'approve' | 'block' | 'unblock' | 'reject', body?: unknown) =>
      request<User>('POST', `/api/admin/users/${id}/${action}`, body ?? {}),
    setRole: (id: number, role: 'admin' | 'user') => request<User>('POST', `/api/admin/users/${id}/role`, { role }),
    setPassword: (id: number, password: string) => request<User>('POST', `/api/admin/users/${id}/password`, { password }),
    saveSettings: (s: Settings) => request<{ settings: Settings; turnError: string }>('PUT', '/api/admin/settings', s),
    testStorage: (driver: string, dsn: string) =>
      request<{ ok: boolean; describe: string; records?: number }>('POST', '/api/admin/storage/test', { driver, dsn }),
    switchStorage: (driver: string, dsn: string) =>
      request<{ ok: boolean; describe: string }>('POST', '/api/admin/storage/switch', { driver, dsn }),
  },
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
