import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from 'lucide-react';
import { useEffect, useState } from 'react';
import { onCallHistoryChanged, startCall } from '../call/engine';
import Avatar from '../components/Avatar';
import Scenery from '../components/Scenery';
import TabBar from '../components/TabBar';
import { api, errorText } from '../lib/api';
import { formatDuration, formatListTime } from '../lib/format';
import type { CallRecord } from '../lib/types';
import { useChat } from '../store/chat';
import { useConfig } from '../store/config';
import { toast } from '../store/toast';
import { HeroHeader } from './ChatsScreen';

function describe(c: CallRecord) {
  const missed = c.direction === 'incoming' && (c.status === 'missed' || c.status === 'busy');
  const Icon = missed ? PhoneMissed : c.direction === 'incoming' ? PhoneIncoming : PhoneOutgoing;
  let label: string;
  if (c.status === 'completed' && c.answeredAt && c.endedAt) label = formatDuration(c.endedAt - c.answeredAt);
  else if (missed) label = 'Missed';
  else if (c.status === 'rejected') label = c.direction === 'outgoing' ? 'Declined' : 'Declined by you';
  else if (c.direction === 'outgoing' && c.status !== 'ongoing') label = 'No answer';
  else label = c.direction === 'incoming' ? 'Incoming' : 'Outgoing';
  return { missed, Icon, label };
}

export default function CallsScreen() {
  const [calls, setCalls] = useState<CallRecord[] | null>(null);
  const presence = useChat((s) => s.presence);
  const f = useConfig((s) => s.features);

  useEffect(() => {
    const load = () =>
      api
        .calls()
        .then(setCalls)
        .catch((e) => {
          setCalls((c) => c ?? []);
          toast(errorText(e));
        });
    load();
    const off = onCallHistoryChanged(() => setTimeout(load, 400));
    return () => {
      off();
    };
  }, []);

  return (
    <div className="screen tab-screen">
      <HeroHeader title="Calls" />
      <div className="scroll list list-top">
        {calls === null ? (
          Array.from({ length: 5 }, (_, i) => <div key={i} className="chat-row skeleton" />)
        ) : calls.length === 0 ? (
          <div className="empty">
            <Phone size={40} strokeWidth={1.5} />
            <p>No calls yet. Open a chat and tap the phone or camera icon.</p>
          </div>
        ) : (
          calls.map((c) => {
            const { missed, Icon, label } = describe(c);
            return (
              <div key={c.id} className="chat-row call-row">
                <Avatar name={c.peer.name} src={c.peer.avatar} online={!!presence[c.peer.id]?.online} />
                <div className="chat-row-body">
                  <div className="chat-row-top">
                    <span className={`chat-name ${missed ? 'danger' : ''}`} dir="auto">
                      {c.peer.name}
                    </span>
                  </div>
                  <div className="chat-row-bottom">
                    <span className={`chat-preview call-meta ${missed ? 'danger' : ''}`}>
                      <Icon size={15} />
                      {c.kind === 'video' ? 'Video' : 'Voice'} · {label} · {formatListTime(c.startedAt)}
                    </span>
                  </div>
                </div>
                {(c.kind === 'video' ? f.videoCalls : f.voiceCalls) && (
                <button
                  className="icon-btn accent call-again"
                  onClick={() => startCall(c.conversationId, c.peer, c.kind)}
                  aria-label={`Call ${c.peer.name}`}
                >
                  {c.kind === 'video' ? <Video size={22} /> : <Phone size={20} />}
                </button>
                )}
              </div>
            );
          })
        )}
        <div className="list-spacer" />
      </div>
      <Scenery variant="footer" className="footer-scene" />
      <TabBar active="/calls" />
    </div>
  );
}
