import { Bluetooth, ChevronLeft, Headphones, Mic, MicOff, Phone, PhoneOff, Volume1, Volume2 } from 'lucide-react';
import {
  declineGroupCall,
  joinGroupCall,
  leaveGroupCall,
  setGroupMinimized,
  toggleGroupMute,
  toggleGroupSpeaker,
  useGroupCall,
} from '../call/group';
import Avatar from '../components/Avatar';
import Scenery from '../components/Scenery';
import { formatDuration } from '../lib/format';
import { useChat } from '../store/chat';
import { CallButton, useNow } from './CallOverlay';

function Backdrop() {
  return (
    <>
      <Scenery variant="full" className="call-bg" />
      <div className="call-bg-shade" />
    </>
  );
}

/** Someone started a call in one of your groups. */
function Incoming() {
  const ringing = useGroupCall((s) => s.ringing)!;
  const conv = useChat((s) => s.conversations[ringing.conversationId]);
  const title = conv?.title ?? 'Group';
  return (
    <div className="call-screen">
      <Backdrop />
      <div className="call-center">
        <div className="call-avatar ringing">
          <Avatar name={title} src={conv?.avatar} group size={148} ring={false} />
        </div>
        <h2 dir="auto">{title}</h2>
        <p className="call-status" dir="auto">
          {ringing.from.name} started a group call
        </p>
      </div>
      <div className="call-controls">
        <CallButton variant="end" label="Decline" onClick={declineGroupCall}>
          <PhoneOff size={28} />
        </CallButton>
        <CallButton variant="accept" label="Join" onClick={() => void joinGroupCall(ringing.conversationId)}>
          <Phone size={28} />
        </CallButton>
      </div>
    </div>
  );
}

function SpeakerButton() {
  const speaker = useGroupCall((s) => s.speaker);
  const route = useGroupCall((s) => s.route);
  if (route === 'media') return null; // Android picks speaker or earphones itself
  const [label, icon] =
    route === 'bluetooth'
      ? ['Bluetooth', <Bluetooth size={26} />]
      : route === 'wired'
        ? ['Headset', <Headphones size={26} />]
        : ['Speaker', speaker ? <Volume2 size={26} /> : <Volume1 size={26} />];
  return (
    <CallButton label={label} on={route ? route === 'speaker' : speaker} onClick={toggleGroupSpeaker}>
      {icon}
    </CallButton>
  );
}

/** Group calls: the incoming ring, the call screen, and the green pill while it's minimized. */
export default function GroupCallOverlay() {
  const s = useGroupCall();
  const id = s.conversationId;
  const conv = useChat((st) => (id ? st.conversations[id] : undefined));
  const me = useChat((st) => st.me);
  const room = id ? s.rooms[id] : undefined;
  const now = useNow(s.phase === 'active');

  if (s.phase === 'idle') return s.ringing ? <Incoming /> : null;

  const title = conv?.title ?? 'Group call';
  const timer = s.phase === 'active' && room ? formatDuration(now - room.startedAt) : '';
  if (s.minimized) {
    return (
      <button className="call-pill" onClick={() => setGroupMinimized(false)}>
        <span className="call-pill-dot" />
        <span className="call-pill-name">{title}</span>
        <span>{timer || 'Joining…'}</span>
        <span className="call-pill-hint">Tap to return</span>
      </button>
    );
  }

  // You first, then everyone else in the order they joined the group.
  const inCall = new Set(room?.participants ?? [me]);
  const people = [me, ...(conv?.members.map((m) => m.id).filter((uid) => uid !== me && inCall.has(uid)) ?? [])];
  const member = (uid: number) => conv?.members.find((m) => m.id === uid);

  return (
    <div className="call-screen">
      <Backdrop />
      <header className="call-top">
        <button className="icon-btn" onClick={() => setGroupMinimized(true)} aria-label="Minimize call">
          <ChevronLeft size={26} />
        </button>
        <Avatar name={title} src={conv?.avatar} group size={42} />
        <div className="call-top-text">
          <span className="call-top-name" dir="auto">
            {title}
          </span>
          <span className="call-top-sub">Group call{timer ? ` · ${timer}` : '…'}</span>
        </div>
      </header>

      <div className="gcall-people">
        {people.map((uid) => {
          const u = member(uid);
          const muted = uid === me ? s.muted : s.peersMuted[uid];
          return (
            <div key={uid} className="gcall-person">
              <span className="gcall-avatar">
                <Avatar name={u?.name ?? '?'} src={u?.avatar} size={76} ring={false} />
                {muted && (
                  <span className="gcall-muted">
                    <MicOff size={14} />
                  </span>
                )}
              </span>
              <span className="gcall-name" dir="auto">
                {uid === me ? 'You' : (u?.name.split(' ')[0] ?? 'Someone')}
              </span>
            </div>
          );
        })}
      </div>
      <p className="call-status gcall-status">
        {s.phase === 'joining' ? 'Joining…' : people.length < 2 ? 'Waiting for others to join…' : `${people.length} in the call`}
      </p>

      <div className="call-controls">
        <CallButton label={s.muted ? 'Unmute' : 'Mute'} on={s.muted} onClick={toggleGroupMute}>
          {s.muted ? <MicOff size={26} /> : <Mic size={26} />}
        </CallButton>
        <CallButton variant="end" label="Leave" onClick={leaveGroupCall}>
          <PhoneOff size={30} />
        </CallButton>
        <SpeakerButton />
      </div>
    </div>
  );
}
