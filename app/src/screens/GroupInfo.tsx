import { Camera, EllipsisVertical, Pencil, Phone, UserPlus } from 'lucide-react';
import { useRef, useState } from 'react';
import Avatar from '../components/Avatar';
import Toggle from '../components/Toggle';
import { api, errorText } from '../lib/api';
import { squareAvatar } from '../lib/media';
import { navigate } from '../lib/router';
import type { Conversation } from '../lib/types';
import { addConversation, isGroupAdmin, useChat } from '../store/chat';
import { toast } from '../store/toast';

// A group's part of the chat info sheet. Its admins (the creator, the
// members they make admin) rename it, change its photo, add and remove
// people, make others admin, and can let only admins send messages.

/** Runs a group change and shows the group as the server returns it. */
async function change(fn: () => Promise<Conversation>, done?: string): Promise<boolean> {
  try {
    addConversation(await fn());
    if (done) toast(done);
    return true;
  } catch (e) {
    toast(errorText(e));
    return false;
  }
}

/** Photo, name and members count; admins can change the photo and the name. */
export function GroupHero({ conv, me, onCall }: { conv: Conversation; me: number; onCall?: () => void }) {
  const admin = isGroupAdmin(conv, me);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(conv.title);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true);
    try {
      const { url } = await api.upload(await squareAvatar(f), 'group.jpg');
      await change(() => api.updateGroup(conv.id, { avatar: url }), 'Group photo changed');
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    const title = name.trim();
    if (!title || title === conv.title) return setEditing(false);
    setBusy(true);
    if (await change(() => api.updateGroup(conv.id, { title }))) setEditing(false);
    setBusy(false);
  }

  return (
    <>
      {admin ? (
        <button className="profile-avatar" onClick={() => file.current?.click()} disabled={busy} aria-label="Change group photo">
          <Avatar name={conv.title} src={conv.avatar} group size={96} />
          <span className="profile-avatar-cam">
            <Camera size={16} />
          </span>
        </button>
      ) : (
        <Avatar name={conv.title} src={conv.avatar} group size={96} />
      )}
      <input ref={file} type="file" accept="image/*" hidden onChange={onPhoto} />
      {editing ? (
        <div className="group-rename">
          <input
            className="field"
            value={name}
            maxLength={64}
            dir="auto"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void rename()}
          />
          <button className="btn btn-primary small" disabled={!name.trim() || busy} onClick={() => void rename()}>
            Save
          </button>
        </div>
      ) : (
        <h2 dir="auto" className="group-title">
          {conv.title}
          {admin && (
            <button
              className="icon-btn"
              onClick={() => {
                setName(conv.title);
                setEditing(true);
              }}
              aria-label="Rename group"
            >
              <Pencil size={16} />
            </button>
          )}
        </h2>
      )}
      <p className="muted">{conv.members.length} members</p>
      {onCall && (
        <div className="sheet-actions">
          <button onClick={onCall}>
            <Phone size={20} />
            Voice call
          </button>
        </div>
      )}
    </>
  );
}

/** Admins only: add people, and who may send messages. */
export function GroupAdminMenu({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  return (
    <>
      <button
        className="menu-item"
        onClick={() => {
          onClose();
          navigate(`/chat/${conv.id}/add`);
        }}
      >
        <UserPlus size={19} />
        Add members
      </button>
      <Toggle
        on={!!conv.onlyAdmins}
        onChange={(onlyAdmins) => void change(() => api.updateGroup(conv.id, { onlyAdmins }))}
        label="Only admins can send messages"
        hint="Everyone else can read and react"
      />
    </>
  );
}

/** Members with their role; admins manage everyone but themselves and the creator. */
export function GroupMembers({ conv, me }: { conv: Conversation; me: number }) {
  const presence = useChat((s) => s.presence);
  const admin = isGroupAdmin(conv, me);
  const [open, setOpen] = useState<number | null>(null); // whose actions are showing

  return (
    <div className="sheet-list">
      <h3 className="section-title">Members</h3>
      {conv.members.map((m) => {
        const isAdmin = !!conv.admins?.includes(m.id);
        const role = m.id === conv.ownerId ? 'Owner' : isAdmin ? 'Admin' : '';
        const manage = admin && m.id !== me && m.id !== conv.ownerId;
        const first = m.name.split(' ')[0];
        return (
          <div key={m.id}>
            <div className="user-row static">
              <Avatar name={m.name} src={m.avatar} size={42} online={!!presence[m.id]?.online} storyOf={m.id} />
              <div className="user-row-body">
                <span className="user-name" dir="auto">
                  {m.name}
                  {m.id === me && ' (you)'}
                </span>
                <span className="user-sub" dir="auto">
                  {m.username ? `@${m.username}` : m.about}
                </span>
              </div>
              {role && <span className="role-tag">{role}</span>}
              {manage && (
                <button className="icon-btn" onClick={() => setOpen(open === m.id ? null : m.id)} aria-label={`Manage ${m.name}`}>
                  <EllipsisVertical size={18} />
                </button>
              )}
            </div>
            {open === m.id && (
              <div className="member-actions">
                <button
                  className="chip-btn"
                  onClick={() =>
                    void change(
                      () => api.setGroupAdmin(conv.id, m.id, !isAdmin),
                      isAdmin ? `${first} is no longer an admin` : `${first} is now an admin`,
                    ).then(() => setOpen(null))
                  }
                >
                  {isAdmin ? 'Remove as admin' : 'Make admin'}
                </button>
                <button
                  className="chip-btn danger"
                  onClick={() => {
                    if (!window.confirm(`Remove ${m.name} from “${conv.title}”?`)) return;
                    void change(() => api.removeMember(conv.id, m.id), `${first} was removed`).then(() => setOpen(null));
                  }}
                >
                  Remove from group
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
