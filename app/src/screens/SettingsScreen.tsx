import {
  AtSign,
  Ban,
  Bell,
  Camera,
  ChevronRight,
  KeyRound,
  LogOut,
  Moon,
  Server,
  ShieldCheck,
  Sun,
  SunMoon,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Avatar from '../components/Avatar';
import Toggle from '../components/Toggle';
import TabBar from '../components/TabBar';
import { api, errorText } from '../lib/api';
import { getServerUrl, isNativeShell } from '../lib/config';
import { disablePush, enablePush, pushAvailable, pushEnabled, pushPermission } from '../lib/push';
import { setTheme, useTheme, type ThemeChoice } from '../lib/theme';
import { navigate } from '../lib/router';
import { socket } from '../lib/socket';
import { logout, updateProfile, useAuth } from '../store/auth';
import { toast } from '../store/toast';
import type { User } from '../lib/types';
import { HeroHeader } from './ChatsScreen';

function useSocketStatus() {
  const [connected, setConnected] = useState(socket.connected);
  useEffect(() => socket.onStatus(setConnected), []);
  return connected;
}

async function squareAvatar(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const size = Math.min(512, side);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that image'))), 'image/jpeg', 0.88),
  );
}

const THEMES: [ThemeChoice, string, typeof Moon][] = [
  ['dark', 'Night', Moon],
  ['light', 'Day', Sun],
  ['system', 'Auto', SunMoon],
];

/** Night sky, sunny day, or whatever the phone uses. */
function ThemePicker() {
  const choice = useTheme((s) => s.choice);
  return (
    <div className="card theme-picker" role="radiogroup" aria-label="Theme">
      {THEMES.map(([value, label, Icon]) => (
        <button
          key={value}
          className={`theme-option ${choice === value ? 'on' : ''}`}
          role="radio"
          aria-checked={choice === value}
          onClick={() => setTheme(value)}
        >
          <Icon size={22} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

export default function SettingsScreen() {
  const me = useAuth((s) => s.me)!;
  const pendingCount = useAuth((s) => s.pendingCount);
  const connected = useSocketStatus();
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCur, setPwCur] = useState('');
  const [pwNext, setPwNext] = useState('');
  const [name, setName] = useState(me.name);
  const [about, setAbout] = useState(me.about);
  const [username, setUsername] = useState(me.username ?? '');
  const [blocked, setBlocked] = useState<User[] | null>(null);
  const [showBlocked, setShowBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  );
  const [pushOn, setPushOn] = useState(pushEnabled);

  const cleanUsername = username.trim().replace(/^@/, '');
  const dirty = name.trim() !== me.name || about.trim() !== me.about || cleanUsername !== (me.username ?? '');

  useEffect(() => {
    if (showBlocked) api.blocks().then(setBlocked).catch((e) => toast(errorText(e)));
  }, [showBlocked]);

  async function setPrivacy(patch: { hidePhoneSearch?: boolean; hideLastSeen?: boolean }) {
    try {
      await updateProfile(patch);
    } catch (e) {
      toast(errorText(e));
    }
  }

  async function unblock(u: User) {
    try {
      await api.unblock(u.id);
      setBlocked((list) => list?.filter((x) => x.id !== u.id) ?? null);
      toast(`${u.name} unblocked`);
    } catch (e) {
      toast(errorText(e));
    }
  }

  async function save() {
    setBusy(true);
    try {
      await updateProfile({ name: name.trim(), about: about.trim(), username: cleanUsername });
      toast('Profile saved');
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function onAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true);
    try {
      const blob = await squareAvatar(f);
      const { url } = await api.upload(blob, 'avatar.jpg');
      await updateProfile({ avatar: url });
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function changePassword() {
    setBusy(true);
    try {
      await api.changePassword(pwCur, pwNext);
      toast('Password changed');
      setPwOpen(false);
      setPwCur('');
      setPwNext('');
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function enableNotifications() {
    const p = await Notification.requestPermission();
    setNotifPermission(p);
  }

  async function setPush(on: boolean) {
    try {
      if (on) {
        const ok = await enablePush(true);
        if (!ok) toast(pushPermission() === 'denied' ? 'Notifications are blocked in this browser’s site settings' : "This browser can't get notifications");
        setPushOn(ok);
      } else {
        await disablePush(true);
        setPushOn(false);
      }
    } catch (e) {
      toast(errorText(e));
    }
  }

  return (
    <div className="screen tab-screen">
      <HeroHeader title="Settings" />
      <div className="scroll list list-top">
        <div className="card profile-card">
          <button className="profile-avatar" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Avatar name={me.name} src={me.avatar} size={84} />
            <span className="profile-avatar-cam">
              <Camera size={16} />
            </span>
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={onAvatar} />
          <div className="profile-text">
            <span className="profile-name" dir="auto">
              {me.name}
            </span>
            <span className="muted ltr-inline">
              {me.phone}
              {me.username ? ` · @${me.username}` : ''}
            </span>
          </div>
        </div>

        {me.role === 'admin' && (
          <button className="card admin-entry" onClick={() => navigate('/admin')}>
            <ShieldCheck size={22} />
            <span className="admin-entry-text">
              <b>Admin panel</b>
              <span className="muted small">Users, features, calls and storage</span>
            </span>
            {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
            <ChevronRight size={20} className="muted" />
          </button>
        )}

        <h3 className="section-title">Profile</h3>
        <div className="card form-card">
          <label className="label">
            Name
            <input className="field" value={name} maxLength={64} dir="auto" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="label">
            ID
            <span className="field-prefix">
              <AtSign size={17} />
              <input
                className="field ltr"
                value={username}
                maxLength={33}
                placeholder="your_id"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
              />
            </span>
            <span className="muted small">People can find you by this ID. 4–32 letters, numbers or _.</span>
          </label>
          <label className="label">
            About
            <input
              className="field"
              value={about}
              maxLength={140}
              dir="auto"
              onChange={(e) => setAbout(e.target.value)}
            />
          </label>
          {dirty && (
            <div className="row-end">
              <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>
                Save changes
              </button>
            </div>
          )}
        </div>

        <h3 className="section-title">Appearance</h3>
        <ThemePicker />

        <h3 className="section-title">Privacy</h3>
        <div className="card list-card">
          <Toggle
            label="Find me by phone number"
            hint={me.hidePhoneSearch ? 'Off — people can only find you by your @ID' : 'Anyone with your number can find you'}
            on={!me.hidePhoneSearch}
            onChange={(v) => void setPrivacy({ hidePhoneSearch: !v })}
          />
          <Toggle
            label="Show my last seen & online"
            hint="Your contacts see when you're online"
            on={!me.hideLastSeen}
            onChange={(v) => void setPrivacy({ hideLastSeen: !v })}
          />
          <button className="setting-row" onClick={() => setShowBlocked((v) => !v)}>
            <Ban size={20} />
            <span>Blocked users{blocked ? ` (${blocked.length})` : ''}</span>
          </button>
          {showBlocked && (
            <div className="blocked-list">
              {blocked === null ? (
                <p className="muted pad">Loading…</p>
              ) : blocked.length === 0 ? (
                <p className="muted pad">You haven't blocked anyone. Block someone from their chat profile.</p>
              ) : (
                blocked.map((u) => (
                  <div key={u.id} className="user-row static">
                    <Avatar name={u.name} src={u.avatar} size={40} />
                    <div className="user-row-body">
                      <span className="user-name" dir="auto">
                        {u.name}
                      </span>
                      <span className="user-sub">{u.username ? `@${u.username}` : u.phone}</span>
                    </div>
                    <button className="chip-btn" onClick={() => void unblock(u)}>
                      Unblock
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <h3 className="section-title">Security</h3>
        <div className="card list-card">
          <button className="setting-row" onClick={() => setPwOpen((v) => !v)}>
            <KeyRound size={20} />
            <span>Change password</span>
          </button>
          {pwOpen && (
            <div className="form-card pad-card">
              <input className="field" type="password" placeholder="Current password" value={pwCur} onChange={(e) => setPwCur(e.target.value)} />
              <input className="field" type="password" placeholder="New password (6+ characters)" value={pwNext} onChange={(e) => setPwNext(e.target.value)} />
              <div className="row-end">
                <button className="btn btn-primary small" disabled={busy || !pwCur || pwNext.length < 6} onClick={changePassword}>
                  Update password
                </button>
              </div>
            </div>
          )}
        </div>

        <h3 className="section-title">Connection</h3>
        <div className="card list-card">
          <div className="setting-row">
            {connected ? <Wifi size={20} className="ok" /> : <WifiOff size={20} className="danger" />}
            <span>{connected ? 'Connected' : 'Connecting…'}</span>
          </div>
          <div className="setting-row">
            <Server size={20} />
            <span className="setting-value">{getServerUrl() || location.origin}</span>
          </div>
          {pushAvailable() ? (
            <Toggle
              label="Notifications"
              hint="New messages and calls, even when Chaty is closed"
              on={pushOn}
              onChange={(v) => void setPush(v)}
            />
          ) : !isNativeShell && typeof Notification !== 'undefined' && notifPermission !== 'granted' && (
            <button className="setting-row" onClick={enableNotifications}>
              <Bell size={20} />
              <span>Enable notifications</span>
            </button>
          )}
        </div>

        <button className="btn btn-danger" onClick={() => logout()}>
          <LogOut size={18} />
          Log out
        </button>
        <p className="muted center small">Chaty · v1.0</p>
        <div className="list-spacer" />
      </div>
      <TabBar active="/settings" />
    </div>
  );
}
