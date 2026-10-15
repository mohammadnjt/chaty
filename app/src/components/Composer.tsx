import { Forward, Mic, Paperclip, Pencil, Reply, SendHorizontal, Smile, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../lib/format';
import { ensureMediaPermission } from '../lib/native';
import { socket } from '../lib/socket';
import type { Message } from '../lib/types';
import { errorText } from '../lib/api';
import { editMessage, forwardWithComment, previewOf, sendMessage } from '../store/chat';
import { useConfig } from '../store/config';
import { pauseVoice } from '../store/player';
import { toast } from '../store/toast';
import EmojiPicker from './EmojiPicker';

const coarsePointer = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

function recorderType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
}

/**
 * Waits until the microphone sends real sound: phones often start with a
 * moment of digital silence, which would otherwise open every voice message.
 * Gives up after `max` ms.
 */
async function micLive(stream: MediaStream, max = 1500) {
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    void ctx.resume();
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    for (const end = Date.now() + max; Date.now() < end; ) {
      analyser.getFloatTimeDomainData(samples);
      if (samples.some((v) => v !== 0)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  } catch {
    /* no Web Audio: start right away */
  } finally {
    void ctx?.close().catch(() => {});
  }
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
  startedAt: number; // 0 while the mic is starting
}

interface Props {
  conversationId: number;
  replyTo: Message | null;
  replyName: string;
  editing: Message | null;
  forwarding: Message | null; // waiting to be forwarded here, with what's typed as a comment
  forwardName: string; // who wrote it
  onDone: () => void; // clears reply / edit / forward
  onFiles: (files: File[]) => void;
}

export default function Composer({ conversationId, replyTo, replyName, editing, forwarding, forwardName, onDone, onFiles }: Props) {
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
  useEffect(
    () => () => {
      live.current?.stream.getTracks().forEach((t) => t.stop());
      live.current = null;
    },
    [],
  );

  // Entering edit mode puts the message text in the box.
  useEffect(() => {
    if (editing) {
      setText(editing.body);
      input.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if ((replyTo || forwarding) && !coarsePointer) input.current?.focus();
  }, [replyTo, forwarding]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [text]);

  // Picking emoji keeps the panel open for more. They go in at the cursor; on
  // phones the box isn't focused, which would bring up the keyboard and close the panel.
  function insertEmoji(e: string) {
    const el = input.current;
    const at = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : text.length;
    setText(text.slice(0, at) + e + text.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      if (!coarsePointer) el.focus();
      el.setSelectionRange(at + e.length, at + e.length);
    });
  }

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
    if (forwarding) {
      setText('');
      onDone();
      forwardWithComment(forwarding, [conversationId], body).catch((e) => toast(errorText(e)));
      return;
    }
    if (!body) return;
    sendMessage(conversationId, { type: 'text', body, replyTo });
    setText('');
    onDone();
    lastTyping.current = 0;
    input.current?.focus();
  }

  // Pictures sent from the phone's keyboard in the Android app (Gboard clipboard, GIFs, stickers).
  const filesRef = useRef(onFiles);
  filesRef.current = onFiles;
  useEffect(() => {
    const onKeyboardImage = (e: Event) => {
      const { url, type } = (e as CustomEvent<{ url: string; type: string }>).detail;
      fetch(url)
        .then((r) => r.blob())
        .then((blob) => {
          const ext = type.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'png';
          filesRef.current([new File([blob], `image.${ext}`, { type })]);
        })
        .catch(() => toast("Couldn't add that picture"));
    };
    window.addEventListener('chaty-keyboard-image', onKeyboardImage);
    return () => window.removeEventListener('chaty-keyboard-image', onKeyboardImage);
  }, []);

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
    // In the Android app the microphone is asked for now, the first time it's needed.
    if (!(await ensureMediaPermission(false))) {
      toast('Allow microphone access to record voice messages');
      return;
    }
    pauseVoice();
    let rec: Recording;
    try {
      // No echo cancelling: nothing plays while recording, and on Android it
      // puts the phone in call mode, which takes a second or two to switch
      // and swallows the start of the message.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
      const type = recorderType();
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      rec = { recorder, stream, chunks: [], startedAt: 0 };
      recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
    } catch {
      toast('Allow microphone access to record voice messages');
      return;
    }
    setEmoji(false);
    setRecording(rec);
    live.current = rec;
    // Recording starts (and the timer runs) once the mic really hears something.
    await micLive(rec.stream);
    if (live.current !== rec) return; // discarded, or the chat closed, meanwhile
    try {
      rec.recorder.start(250);
    } catch {
      rec.stream.getTracks().forEach((t) => t.stop());
      setRecording(null);
      toast("Couldn't start recording");
      return;
    }
    const started = { ...rec, startedAt: Date.now() };
    live.current = started;
    setRecording(started);
  }

  function stopRecording(send: boolean) {
    const rec = recording;
    if (!rec) return;
    setRecording(null);
    live.current = null;
    if (!rec.startedAt) {
      // The mic was still starting: nothing recorded yet.
      rec.stream.getTracks().forEach((t) => t.stop());
      return;
    }
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
  const showMic = !hasText && !editing && !forwarding && f.voiceMessages;

  return (
    <div className="composer-wrap">
      {emoji && !recording && (
        <EmojiPicker onPick={insertEmoji} />
      )}
      {(replyTo || editing || forwarding) && !recording && (
        <div className="composer-context">
          {editing ? <Pencil size={18} /> : forwarding ? <Forward size={18} /> : <Reply size={18} />}
          <div className="composer-context-text">
            <span className="composer-context-title" dir="auto">
              {editing ? 'Edit message' : forwarding ? `Forward from ${forwardName}` : `Reply to ${replyName}`}
            </span>
            <span className="composer-context-body" dir="auto">
              {previewOf(editing ?? forwarding ?? replyTo)}
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
            <span className={`rec-dot ${recording.startedAt ? '' : 'waiting'}`} />
            <span className="rec-time">{formatDuration(recording.startedAt ? Date.now() - recording.startedAt : 0)}</span>
            <span className="rec-hint">{recording.startedAt ? 'Recording…' : 'Starting the mic…'}</span>
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
              placeholder={editing ? 'Edit message…' : forwarding ? 'Add a comment…' : 'Type a message...'}
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
          disabled={!recording && !hasText && !showMic && !editing && !forwarding}
          onClick={() => (recording ? stopRecording(true) : showMic ? startRecording() : submit())}
          aria-label={recording || !showMic ? 'Send' : 'Record voice message'}
        >
          {showMic && !recording ? <Mic size={22} /> : <SendHorizontal size={21} />}
        </button>
      </div>
    </div>
  );
}
