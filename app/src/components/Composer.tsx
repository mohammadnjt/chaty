import { Mic, Paperclip, Pencil, Reply, SendHorizontal, Smile, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../lib/format';
import { socket } from '../lib/socket';
import type { Message } from '../lib/types';
import { editMessage, previewOf, sendMessage } from '../store/chat';
import { useConfig } from '../store/config';
import { toast } from '../store/toast';
import EmojiPicker from './EmojiPicker';

const coarsePointer = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

function recorderType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
}

function extFor(type: string) {
  if (type.includes('mp4')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  return 'webm';
}

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  startedAt: number;
}

interface Props {
  conversationId: number;
  replyTo: Message | null;
  replyName: string;
  editing: Message | null;
  onDone: () => void; // clears reply / edit
  onFiles: (files: File[]) => void;
}

export default function Composer({ conversationId, replyTo, replyName, editing, onDone, onFiles }: Props) {
  const f = useConfig((s) => s.features);
  const [text, setText] = useState('');
  const [emoji, setEmoji] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [, tick] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      tick((n) => n + 1);
      socket.send('typing', { conversationId, kind: 'recording' });
    }, 1000);
    return () => clearInterval(t);
  }, [recording, conversationId]);

  // Stop the mic if the screen goes away mid-recording.
  const live = useRef<Recording | null>(null);
  live.current = recording;
  useEffect(() => () => live.current?.stream.getTracks().forEach((t) => t.stop()), []);

  // Entering edit mode puts the message text in the box.
  useEffect(() => {
    if (editing) {
      setText(editing.body);
      input.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [text]);

  function onChange(v: string) {
    setText(v);
    const now = Date.now();
    if (v && !editing && now - lastTyping.current > 2500) {
      lastTyping.current = now;
      socket.send('typing', { conversationId, kind: 'typing' });
    }
  }

  function submit() {
    const body = text.trim();
    if (editing) {
      if (body !== editing.body && (body || editing.type !== 'text')) void editMessage(editing, body);
      setText('');
      onDone();
      return;
    }
    if (!body) return;
    sendMessage(conversationId, { type: 'text', body, replyTo });
    setText('');
    onDone();
    lastTyping.current = 0;
    input.current?.focus();
  }

  function onPaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.files);
    if (files.length && !editing) {
      e.preventDefault();
      onFiles(files);
    }
  }

  function onPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) onFiles(files);
  }

  async function startRecording() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast('Voice messages need a secure (https) connection');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = recorderType();
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const rec: Recording = { recorder, stream, chunks: [], startedAt: Date.now() };
      recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
      recorder.start(250);
      setEmoji(false);
      setRecording(rec);
    } catch {
      toast('Allow microphone access to record voice messages');
    }
  }

  function stopRecording(send: boolean) {
    const rec = recording;
    if (!rec) return;
    setRecording(null);
    const duration = Date.now() - rec.startedAt;
    rec.recorder.onstop = () => {
      rec.stream.getTracks().forEach((t) => t.stop());
      if (!send) return;
      if (duration < 700) {
        toast('Hold on a bit longer to record');
        return;
      }
      const type = rec.recorder.mimeType || 'audio/webm';
      const blob = new Blob(rec.chunks, { type: type.split(';')[0] });
      sendMessage(conversationId, { type: 'audio', file: blob, fileName: `voice.${extFor(type)}`, duration, replyTo });
      onDone();
    };
    rec.recorder.stop();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape' && (editing || replyTo)) {
      setText(editing ? '' : text);
      onDone();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !coarsePointer && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'ArrowUp' && !text) {
      // like Telegram: ↑ in an empty box edits your last message — handled by the chat screen
      window.dispatchEvent(new CustomEvent('chaty:edit-last'));
    }
  }

  const hasText = text.trim().length > 0;
  const canAttach = f.photos || f.files;
  const showMic = !hasText && !editing && f.voiceMessages;

  return (
    <div className="composer-wrap">
      {emoji && !recording && (
        <EmojiPicker
          onPick={(e) => {
            setText((t) => t + e);
            input.current?.focus();
          }}
        />
      )}
      {(replyTo || editing) && !recording && (
        <div className="composer-context">
          {editing ? <Pencil size={18} /> : <Reply size={18} />}
          <div className="composer-context-text">
            <span className="composer-context-title">{editing ? 'Edit message' : `Reply to ${replyName}`}</span>
            <span className="composer-context-body" dir="auto">
              {previewOf(editing ?? replyTo)}
            </span>
          </div>
          <button
            className="icon-btn"
            onClick={() => {
              if (editing) setText('');
              onDone();
            }}
            aria-label="Cancel"
          >
            <X size={20} />
          </button>
        </div>
      )}
      <div className="composer">
        {recording ? (
          <div className="composer-pill recording">
            <button className="icon-btn" onClick={() => stopRecording(false)} aria-label="Discard recording">
              <Trash2 size={20} />
            </button>
            <span className="rec-dot" />
            <span className="rec-time">{formatDuration(Date.now() - recording.startedAt)}</span>
            <span className="rec-hint">Recording…</span>
          </div>
        ) : (
          <div className="composer-pill">
            <button className={`icon-btn ${emoji ? 'on' : ''}`} onClick={() => setEmoji((v) => !v)} aria-label="Emoji">
              <Smile size={22} />
            </button>
            <textarea
              ref={input}
              rows={1}
              dir="auto"
              value={text}
              placeholder={editing ? 'Edit message…' : 'Type a message...'}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onFocus={() => coarsePointer && setEmoji(false)}
            />
            {canAttach && !editing && (
              <button className="icon-btn" onClick={() => file.current?.click()} aria-label="Attach">
                <Paperclip size={21} />
              </button>
            )}
            <input
              ref={file}
              type="file"
              multiple
              accept={f.files ? undefined : 'image/*'}
              hidden
              onChange={onPicked}
            />
          </div>
        )}
        <button
          className="send-btn"
          disabled={!recording && !hasText && !showMic && !editing}
          onClick={() => (recording ? stopRecording(true) : showMic ? startRecording() : submit())}
          aria-label={recording || !showMic ? 'Send' : 'Record voice message'}
        >
          {showMic && !recording ? <Mic size={22} /> : <SendHorizontal size={21} />}
        </button>
      </div>
    </div>
  );
}
