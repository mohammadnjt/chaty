export interface User {
  id: number;
  name: string;
  username?: string; // public ID, searchable as @username
  phone: string; // masked for other people, full for yourself and admins
  avatar: string;
  about: string;
  lastSeen: number;
  online: boolean;
  role?: 'user' | 'admin';
  status?: 'pending' | 'active' | 'blocked';
  createdAt?: number;
  // privacy, only present on your own profile
  hidePhoneSearch?: boolean;
  hideLastSeen?: boolean;
}

export type MessageType = 'text' | 'image' | 'audio' | 'video' | 'file' | 'deleted';

export interface ReplyPreview {
  id: number;
  senderId: number;
  type: MessageType;
  body: string;
}

export interface Message {
  id: number; // 0 while still sending
  conversationId: number;
  senderId: number;
  type: MessageType;
  body: string;
  mediaUrl?: string;
  fileName?: string;
  fileSize?: number;
  duration?: number; // ms
  clientId?: string;
  reply?: ReplyPreview;
  forwardedFrom?: string;
  reactions?: Record<string, number[]>;
  editedAt?: number;
  createdAt: number;
  // client-only
  status?: 'sending' | 'failed';
  localUrl?: string;
  progress?: number;
}

export interface Conversation {
  id: number;
  type: 'direct' | 'group';
  title: string;
  avatar: string;
  members: User[];
  lastMessage: Message | null;
  pinned: Message | null;
  unread: number;
  reads: Record<string, number>;
  createdAt: number;
  muted: boolean;
  blocked: boolean; // you blocked the other person (1:1 chats)
}

export type CallKind = 'audio' | 'video';

export interface CallRecord {
  id: string;
  conversationId: number;
  kind: CallKind;
  status: 'ringing' | 'ongoing' | 'completed' | 'missed' | 'rejected' | 'busy';
  direction: 'incoming' | 'outgoing';
  peer: User;
  startedAt: number;
  answeredAt: number;
  endedAt: number;
}

export interface Features {
  voiceCalls: boolean;
  videoCalls: boolean;
  groups: boolean;
  photos: boolean;
  files: boolean;
  voiceMessages: boolean;
  editMessages: boolean;
  deleteMessages: boolean;
  reactions: boolean;
  forwarding: boolean;
}

export interface AppConfig {
  appName: string;
  features: Features;
  maxUploadMB: number;
  calls: {
    mode: 'auto' | 'p2p' | 'relay';
    p2pTimeoutSec: number;
    iceServers: RTCIceServer[];
  };
}

export interface Settings {
  appName: string;
  requireApproval: boolean;
  registrationOpen: boolean;
  maxUploadMB: number;
  features: Features;
  calls: {
    mode: 'auto' | 'p2p' | 'relay';
    p2pTimeoutSec: number;
    stunServers: string[];
    turnEnabled: boolean;
    turnPublicIp: string;
    turnHost: string;
    turnPort: number;
    turnUser: string;
    turnPassword: string;
    turnRelayMin: number;
    turnRelayMax: number;
    extraIce: string;
  };
  storage: { driver: 'file' | 'sqlite' | 'postgres' | 'mysql'; dsn: string };
}

export interface AdminOverview {
  stats: {
    users: number;
    pending: number;
    blocked: number;
    conversations: number;
    groups: number;
    messages: number;
    calls: number;
  };
  online: number;
  storage: { describe: string; error: string };
  turn: { running: boolean; error: string };
  settings: Settings;
}
