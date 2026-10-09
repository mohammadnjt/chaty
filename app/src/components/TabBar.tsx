import { CircleDot, MessageSquare, Phone, Settings } from 'lucide-react';
import { navigate } from '../lib/router';
import { useChat } from '../store/chat';
import { useStories } from '../store/stories';

const TABS = [
  { path: '/', label: 'Chats', Icon: MessageSquare },
  { path: '/calls', label: 'Calls', Icon: Phone },
  { path: '/status', label: 'Status', Icon: CircleDot },
  { path: '/settings', label: 'Settings', Icon: Settings },
];

export default function TabBar({ active }: { active: string }) {
  const unreadChats = useChat((s) => Object.values(s.conversations).filter((c) => c.unread > 0).length);
  const newStories = useStories((s) => s.feed.some((g) => g.unseen));
  return (
    <nav className="tabbar">
      {TABS.map(({ path, label, Icon }) => {
        const on = active === path;
        return (
          <button key={path} className={`tab ${on ? 'tab-on' : ''}`} onClick={() => navigate(path, { replace: true })}>
            <span className="tab-icon">
              <Icon size={22} strokeWidth={on ? 2.3 : 1.9} fill={on && path === '/' ? 'currentColor' : 'none'} />
              {path === '/' && unreadChats > 0 && !on && <span className="tab-badge">{unreadChats}</span>}
              {path === '/status' && newStories && !on && <span className="tab-dot" />}
            </span>
            <span className="tab-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
