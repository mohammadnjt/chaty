import { useEffect, useState } from 'react';
import Logo from './components/Logo';
import Scenery from './components/Scenery';
import { matchPath, usePath } from './lib/router';
import { socket } from './lib/socket';
import { unlockAudio } from './lib/sounds';
import AdminScreen from './screens/AdminScreen';
import AuthScreen from './screens/AuthScreen';
import CallOverlay, { RemoteAudio } from './screens/CallOverlay';
import CallsScreen from './screens/CallsScreen';
import ChatScreen from './screens/ChatScreen';
import ChatsScreen from './screens/ChatsScreen';
import { NewChatScreen, NewGroupScreen } from './screens/NewChatScreen';
import SettingsScreen from './screens/SettingsScreen';
import StatusScreen from './screens/StatusScreen';
import { initAuth, useAuth } from './store/auth';
import { useToasts } from './store/toast';

function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** A thin moving line along the top while the app is reconnecting. */
function ConnectionBar() {
  const [down, setDown] = useState(false);
  useEffect(() => {
    let t: number | undefined;
    const update = (connected: boolean) => {
      clearTimeout(t);
      // Don't flash it for a blip.
      if (connected) setDown(false);
      else t = window.setTimeout(() => setDown(true), 800);
    };
    update(socket.connected);
    const off = socket.onStatus(update);
    return () => {
      off();
      clearTimeout(t);
    };
  }, []);
  return down ? <div className="conn-bar" role="status" aria-label="Connecting…" /> : null;
}

function Screen({ path }: { path: string }) {
  const isAdmin = useAuth((s) => s.me?.role === 'admin');
  const chat = matchPath('/chat/:id', path);
  if (chat) return <ChatScreen key={chat.id} id={Number(chat.id)} />;
  switch (path) {
    case '/calls':
      return <CallsScreen />;
    case '/status':
      return <StatusScreen />;
    case '/settings':
      return <SettingsScreen />;
    case '/new':
      return <NewChatScreen />;
    case '/new-group':
      return <NewGroupScreen />;
    case '/admin':
      return isAdmin ? <AdminScreen /> : <ChatsScreen />;
    default:
      return <ChatsScreen />;
  }
}

export default function App() {
  const status = useAuth((s) => s.status);
  const path = usePath();

  useEffect(() => {
    void initAuth();
    unlockAudio();
  }, []);

  return (
    <div className="app">
      {status === 'loading' ? (
        <div className="splash">
          <Scenery variant="full" className="auth-bg" />
          <Logo size={72} />
        </div>
      ) : status === 'guest' ? (
        <AuthScreen />
      ) : (
        <>
          <Screen path={path} />
          <ConnectionBar />
          <CallOverlay />
          <RemoteAudio />
        </>
      )}
      <Toasts />
    </div>
  );
}
