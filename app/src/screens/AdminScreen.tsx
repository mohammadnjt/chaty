import { Check, ChevronLeft, Database, KeyRound, Package, RefreshCw, Shield, ShieldOff, Upload, UserCheck, UserX, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import Avatar from '../components/Avatar';
import Toggle from '../components/Toggle';
import { api, errorText, type AndroidApp } from '../lib/api';
import { formatBytes, formatListTime } from '../lib/format';
import { goBack } from '../lib/router';
import { socket } from '../lib/socket';
import type { AdminOverview, Features, Settings, User } from '../lib/types';
import { refreshPendingCount, useAuth } from '../store/auth';
import { toast } from '../store/toast';

type Tab = 'users' | 'features' | 'calls' | 'storage' | 'general';

const FEATURE_LABELS: [keyof Features, string, string][] = [
  ['voiceCalls', 'Voice calls', 'Audio calls between two people'],
  ['videoCalls', 'Video calls', 'Camera calls between two people'],
  ['groups', 'Groups', 'Creating group chats'],
  ['photos', 'Photos', 'Sending pictures (also pasted ones)'],
  ['files', 'Files & videos', 'Sending documents, videos and any other file'],
  ['voiceMessages', 'Voice messages', 'Recording audio notes'],
  ['editMessages', 'Editing', 'Editing sent messages'],
  ['deleteMessages', 'Deleting', 'Deleting messages for me / everyone'],
  ['reactions', 'Reactions', 'Emoji reactions on messages'],
  ['forwarding', 'Forwarding', 'Forwarding messages to other chats'],
];

function UserRow({ u, me, onChange }: { u: User; me: number; onChange: (u: User | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState('');
  const run = async (fn: () => Promise<User | null>) => {
    setBusy(true);
    try {
      onChange(await fn());
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const self = u.id === me;
  return (
    <div className="admin-user">
      <div className="admin-user-main">
        <Avatar name={u.name} src={u.avatar} size={44} online={u.online} />
        <div className="user-row-body">
          <span className="user-name" dir="auto">
            {u.name} {u.role === 'admin' && <span className="tag accent-tag">admin</span>}
            {u.status === 'pending' && <span className="tag warn-tag">pending</span>}
            {u.status === 'blocked' && <span className="tag danger-tag">blocked</span>}
          </span>
          <span className="user-sub ltr-inline">
            {u.phone}
            {u.username ? ` · @${u.username}` : ''} · joined {formatListTime(u.createdAt ?? 0)}
          </span>
        </div>
      </div>
      <div className="admin-actions">
        {u.status === 'pending' && (
          <>
            <button className="chip-btn ok" disabled={busy} onClick={() => run(() => api.admin.userAction(u.id, 'approve'))}>
              <UserCheck size={16} /> Approve
            </button>
            <button
              className="chip-btn danger"
              disabled={busy}
              onClick={() => run(async () => (await api.admin.userAction(u.id, 'reject'), null))}
            >
              <UserX size={16} /> Reject
            </button>
          </>
        )}
        {u.status === 'active' && !self && (
          <>
            <button
              className="chip-btn"
              disabled={busy}
              onClick={() => run(() => api.admin.setRole(u.id, u.role === 'admin' ? 'user' : 'admin'))}
            >
              {u.role === 'admin' ? <ShieldOff size={16} /> : <Shield size={16} />}
              {u.role === 'admin' ? 'Remove admin' : 'Make admin'}
            </button>
            <button className="chip-btn danger" disabled={busy} onClick={() => run(() => api.admin.userAction(u.id, 'block'))}>
              <UserX size={16} /> Block
            </button>
          </>
        )}
        {u.status === 'blocked' && (
          <button className="chip-btn ok" disabled={busy} onClick={() => run(() => api.admin.userAction(u.id, 'unblock'))}>
            <UserCheck size={16} /> Unblock
          </button>
        )}
        <button className="chip-btn" onClick={() => setPwOpen((v) => !v)}>
          <KeyRound size={16} /> Password
        </button>
      </div>
      {pwOpen && (
        <div className="admin-pw">
          <input className="field" type="text" placeholder="New password (6+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} />
          <button
            className="btn btn-primary small"
            disabled={busy || pw.length < 6}
            onClick={() =>
              run(async () => {
                const r = await api.admin.setPassword(u.id, pw);
                toast('Password changed');
                setPw('');
                setPwOpen(false);
                return r;
              })
            }
          >
            Set
          </button>
        </div>
      )}
    </div>
  );
}

function UsersTab({ overview }: { overview: AdminOverview | null }) {
  const me = useAuth((s) => s.me!.id);
  const [users, setUsers] = useState<User[] | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all' | 'blocked'>('pending');
  const [q, setQ] = useState('');

  const load = () =>
    api.admin
      .users()
      .then((list) => {
        setUsers(list);
        if (!list.some((u) => u.status === 'pending')) setFilter((f) => (f === 'pending' ? 'all' : f));
      })
      .catch((e) => toast(errorText(e)));

  useEffect(() => {
    void load();
    return socket.on('admin:pending', () => void load());
  }, []);

  const pending = users?.filter((u) => u.status === 'pending').length ?? 0;
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (users ?? [])
      .filter((u) => (filter === 'all' ? true : u.status === filter))
      .filter((u) => !query || u.name.toLowerCase().includes(query) || u.phone.includes(query));
  }, [users, filter, q]);

  function onChange(id: number, next: User | null) {
    setUsers((list) => (next ? list!.map((u) => (u.id === id ? { ...u, ...next } : u)) : list!.filter((u) => u.id !== id)));
    refreshPendingCount();
  }

  return (
    <>
      {overview && (
        <div className="stat-grid">
          <div className="stat">
            <b>{overview.stats.users}</b>
            <span>users</span>
          </div>
          <div className="stat">
            <b>{overview.online}</b>
            <span>online</span>
          </div>
          <div className="stat">
            <b>{overview.stats.messages}</b>
            <span>messages</span>
          </div>
          <div className="stat">
            <b>{overview.stats.calls}</b>
            <span>calls</span>
          </div>
        </div>
      )}
      <div className="chips pad-x">
        <button className={`chip ${filter === 'pending' ? 'on' : ''}`} onClick={() => setFilter('pending')}>
          Pending {pending > 0 && `(${pending})`}
        </button>
        <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
          All
        </button>
        <button className={`chip ${filter === 'blocked' ? 'on' : ''}`} onClick={() => setFilter('blocked')}>
          Blocked
        </button>
        <button className="chip" onClick={() => void load()} aria-label="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="search-wrap">
        <label className="search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone" />
        </label>
      </div>
      {users === null ? (
        <p className="muted pad">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="muted pad">{filter === 'pending' ? 'No one is waiting for approval.' : 'No users here.'}</p>
      ) : (
        shown.map((u) => <UserRow key={u.id} u={u} me={me} onChange={(n) => onChange(u.id, n)} />)
      )}
    </>
  );
}

function SaveBar({ dirty, busy, onSave }: { dirty: boolean; busy: boolean; onSave: () => void }) {
  return (
    <div className="save-bar">
      <button className="btn btn-primary wide" disabled={!dirty || busy} onClick={onSave}>
        <Check size={18} /> {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
      </button>
    </div>
  );
}

function StorageTab({ overview, reload }: { overview: AdminOverview; reload: () => void }) {
  const cur = overview.settings.storage;
  const [driver, setDriver] = useState<string>(cur.driver || 'file');
  const [dsn, setDsn] = useState(cur.dsn);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);

  const placeholder: Record<string, string> = {
    sqlite: 'Path to a .db file (empty = files/data/chaty.db)',
    postgres: 'postgres://user:password@host:5432/chaty',
    mysql: 'mysql://user:password@host:3306/chaty',
  };

  async function test() {
    setBusy(true);
    setResult('');
    try {
      const r = await api.admin.testStorage(driver, dsn);
      setResult(`✓ Connected: ${r.describe}${r.records !== undefined ? ` (${r.records} records already there)` : ''}`);
    } catch (e) {
      setResult(`✗ ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function switchNow() {
    if (!window.confirm('Copy all data to this storage and use it from now on?')) return;
    setBusy(true);
    try {
      const r = await api.admin.switchStorage(driver, dsn);
      toast(`Now using ${r.describe}`);
      reload();
    } catch (e) {
      setResult(`✗ ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card form-card">
      <div className="storage-now">
        <Database size={20} />
        <div>
          <b>In use:</b> <span className="muted ltr-inline">{overview.storage.describe}</span>
          {overview.storage.error && <p className="form-error">{overview.storage.error}</p>}
        </div>
      </div>
      <p className="muted small">
        The default is a JSON Lines file in the <code>files</code> folder: every change is appended, so a crash or
        power cut can't corrupt earlier data. You can move everything to a database at any time — data is copied
        over automatically.
      </p>
      <label className="label">
        Storage
        <select className="field" value={driver} onChange={(e) => setDriver(e.target.value)}>
          <option value="file">JSON file (recommended)</option>
          <option value="sqlite">SQLite file</option>
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL / MariaDB</option>
        </select>
      </label>
      {driver !== 'file' && (
        <label className="label">
          Database address
          <input className="field ltr" value={dsn} placeholder={placeholder[driver]} onChange={(e) => setDsn(e.target.value)} />
        </label>
      )}
      {result && <p className={result.startsWith('✓') ? 'form-ok' : 'form-error'}>{result}</p>}
      <div className="row-end">
        {driver !== 'file' && (
          <button className="btn btn-ghost" disabled={busy} onClick={test}>
            Test connection
          </button>
        )}
        <button
          className="btn btn-primary"
          disabled={busy || (driver === (cur.driver || 'file') && dsn === cur.dsn)}
          onClick={switchNow}
        >
          Switch &amp; copy data
        </button>
      </div>
    </div>
  );
}

function AndroidCard() {
  const [info, setInfo] = useState<AndroidApp | null | undefined>(undefined);
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    api.publicConfig().then((c) => setInfo(c.android)).catch(() => setInfo(null));
  }, []);

  async function upload() {
    if (!file) return;
    setProgress(0);
    try {
      setInfo(await api.admin.uploadAndroid(file, version.trim(), setProgress));
      setFile(null);
      setVersion('');
      toast('Android app uploaded');
    } catch (e) {
      toast(errorText(e));
    } finally {
      setProgress(null);
    }
  }

  return (
    <>
      <h3 className="section-title">Android app</h3>
      <div className="card form-card">
        <div className="storage-now">
          <Package size={20} />
          <div>
            {info === undefined ? (
              <span className="muted">Loading…</span>
            ) : info ? (
              <>
                <b>Version {info.version || '—'}</b>{' '}
                <span className="muted">
                  · {formatBytes(info.size)} · uploaded {formatListTime(info.updatedAt)}
                </span>
                <p className="muted small ltr-inline">Download link: {location.origin}{info.url}</p>
              </>
            ) : (
              <span className="muted">No APK uploaded yet — the landing page shows “coming soon”.</span>
            )}
          </div>
        </div>
        <label className="label">
          New APK
          <input className="field" type="file" accept=".apk,application/vnd.android.package-archive" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label className="label">
          Version (shown to users)
          <input className="field ltr" placeholder="1.1.0" value={version} onChange={(e) => setVersion(e.target.value)} />
        </label>
        <div className="row-end">
          <button className="btn btn-primary" disabled={!file || progress !== null} onClick={upload}>
            <Upload size={18} />
            {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : 'Upload'}
          </button>
        </div>
      </div>
    </>
  );
}

export default function AdminScreen() {
  const [tab, setTab] = useState<Tab>('users');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    api.admin
      .overview()
      .then((o) => {
        setOverview(o);
        setDraft(o.settings);
      })
      .catch((e) => toast(errorText(e)));

  const dirty = !!overview && !!draft && JSON.stringify(overview.settings) !== JSON.stringify(draft);

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const r = await api.admin.saveSettings(draft);
      toast(r.turnError ? `Saved, but TURN failed: ${r.turnError}` : 'Settings saved');
      await reload();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // Refresh when switching tabs (unless there are unsaved edits).
  useEffect(() => {
    if (!dirty) void reload();
  }, [tab]);

  const set = (fn: (s: Settings) => Settings) => setDraft((d) => (d ? fn(structuredClone(d)) : d));
  const calls = draft?.calls;

  return (
    <div className="screen push">
      <header className="page-header">
        <button className="icon-btn" onClick={() => goBack('/settings')} aria-label="Back">
          <ChevronLeft size={26} />
        </button>
        <h2>Admin panel</h2>
      </header>
      <div className="tabs-row">
        {(
          [
            ['users', 'Users'],
            ['features', 'Features'],
            ['calls', 'Calls'],
            ['storage', 'Storage'],
            ['general', 'General'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} className={`tab-pill ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {t === 'users' && <Users size={15} />} {label}
          </button>
        ))}
      </div>

      <div className="scroll list">
        {tab === 'users' && <UsersTab overview={overview} />}

        {tab === 'features' && draft && (
          <>
            <div className="card list-card">
              {FEATURE_LABELS.map(([key, label, hint]) => (
                <Toggle
                  key={key}
                  label={label}
                  hint={hint}
                  on={draft.features[key]}
                  onChange={(v) => set((s) => ((s.features[key] = v), s))}
                />
              ))}
            </div>
            <SaveBar dirty={dirty} busy={busy} onSave={save} />
          </>
        )}

        {tab === 'calls' && draft && calls && overview && (
          <>
            <div className="card form-card">
              <label className="label">
                How calls connect
                <div className="segmented three">
                  {(
                    [
                      ['auto', 'Automatic'],
                      ['p2p', 'Direct only'],
                      ['relay', 'Via server'],
                    ] as const
                  ).map(([m, label]) => (
                    <button key={m} type="button" className={calls.mode === m ? 'on' : ''} onClick={() => set((s) => ((s.calls.mode = m), s))}>
                      {label}
                    </button>
                  ))}
                </div>
              </label>
              <p className="muted small">
                <b>Automatic</b> tries a direct WebRTC connection (and the TURN relay) first; if it doesn't connect
                within the timeout — for example because the network blocks call traffic — the call continues
                through this server over the same secure connection the chat uses. <b>Via server</b> always does
                that.
              </p>
              <label className="label">
                Switch to the server after (seconds)
                <input
                  className="field"
                  type="number"
                  min={3}
                  max={60}
                  value={calls.p2pTimeoutSec}
                  onChange={(e) => set((s) => ((s.calls.p2pTimeoutSec = Number(e.target.value)), s))}
                />
              </label>
            </div>

            <h3 className="section-title">Built-in TURN relay</h3>
            <div className="card form-card">
              <Toggle
                label="Run TURN server"
                hint={
                  overview.turn.running
                    ? 'Running (UDP + TCP)'
                    : overview.turn.error
                      ? `Not running: ${overview.turn.error}`
                      : 'Helps calls through strict NATs and mobile networks'
                }
                on={calls.turnEnabled}
                onChange={(v) => set((s) => ((s.calls.turnEnabled = v), s))}
              />
              <label className="label">
                Server public IP
                <input className="field ltr" value={calls.turnPublicIp} placeholder="203.0.113.10" onChange={(e) => set((s) => ((s.calls.turnPublicIp = e.target.value.trim()), s))} />
              </label>
              <label className="label">
                Host name for clients (optional)
                <input className="field ltr" value={calls.turnHost} placeholder="turn.example.com" onChange={(e) => set((s) => ((s.calls.turnHost = e.target.value.trim()), s))} />
              </label>
              <div className="field-row">
                <label className="label">
                  Port
                  <input className="field" type="number" value={calls.turnPort} onChange={(e) => set((s) => ((s.calls.turnPort = Number(e.target.value)), s))} />
                </label>
                <label className="label">
                  Relay ports
                  <input
                    className="field ltr"
                    value={`${calls.turnRelayMin}-${calls.turnRelayMax}`}
                    onChange={(e) =>
                      set((s) => {
                        const [a, b] = e.target.value.split('-').map((x) => Number(x.trim()));
                        s.calls.turnRelayMin = a || 0;
                        s.calls.turnRelayMax = b || 0;
                        return s;
                      })
                    }
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="label">
                  Username
                  <input className="field ltr" value={calls.turnUser} onChange={(e) => set((s) => ((s.calls.turnUser = e.target.value), s))} />
                </label>
                <label className="label">
                  Password
                  <input className="field ltr" value={calls.turnPassword} onChange={(e) => set((s) => ((s.calls.turnPassword = e.target.value), s))} />
                </label>
              </div>
              <p className="muted small">Open UDP and TCP on the port above, and UDP on the relay port range, in the server firewall.</p>
            </div>

            <h3 className="section-title">STUN / ICE servers</h3>
            <div className="card form-card">
              <label className="label">
                STUN servers (one per line)
                <textarea
                  className="field area ltr"
                  rows={3}
                  value={calls.stunServers.join('\n')}
                  onChange={(e) => set((s) => ((s.calls.stunServers = e.target.value.split('\n')), s))}
                />
              </label>
              <label className="label">
                Extra ICE servers (JSON, optional)
                <textarea
                  className="field area ltr"
                  rows={3}
                  placeholder='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
                  value={calls.extraIce}
                  onChange={(e) => set((s) => ((s.calls.extraIce = e.target.value), s))}
                />
              </label>
            </div>
            <SaveBar dirty={dirty} busy={busy} onSave={save} />
          </>
        )}

        {tab === 'storage' && overview && <StorageTab overview={overview} reload={reload} />}

        {tab === 'general' && draft && (
          <>
            <div className="card form-card">
              <label className="label">
                App name
                <input className="field" value={draft.appName} onChange={(e) => set((s) => ((s.appName = e.target.value), s))} />
              </label>
              <Toggle
                label="Open sign-ups"
                hint="Anyone with the app can create an account"
                on={draft.registrationOpen}
                onChange={(v) => set((s) => ((s.registrationOpen = v), s))}
              />
              <Toggle
                label="Admin approval"
                hint="New accounts can't sign in until an admin approves them"
                on={draft.requireApproval}
                onChange={(v) => set((s) => ((s.requireApproval = v), s))}
              />
              <label className="label">
                Max upload size (MB)
                <input
                  className="field"
                  type="number"
                  min={1}
                  max={2048}
                  value={draft.maxUploadMB}
                  onChange={(e) => set((s) => ((s.maxUploadMB = Number(e.target.value)), s))}
                />
              </label>
            </div>
            <SaveBar dirty={dirty} busy={busy} onSave={save} />
            <AndroidCard />
          </>
        )}
        <div className="list-spacer" />
      </div>
    </div>
  );
}
