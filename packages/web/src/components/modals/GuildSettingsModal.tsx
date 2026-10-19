import type { GuildBan } from '@konusgac/shared';
import { hasPerm, Perm, PERMISSION_LABELS, type PermName, type Role } from '@konusgac/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { displayName, getState, guildPerms, useStore } from '../../state';
import { Avatar } from '../Avatar';
import { attempt, Modal } from './Modal';

type Tab = 'general' | 'roles' | 'members' | 'bans';

export function GuildSettingsModal({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const g = useStore((s) => s.guilds[guildId]);
  const me = useStore((s) => s.me);
  const [tab, setTab] = useState<Tab>('general');
  if (!g || !me) return null;

  const perms = guildPerms(getState(), guildId);
  const tabs: [Tab, string, boolean][] = [
    ['general', 'Genel', true],
    ['roles', 'Roller', hasPerm(perms, Perm.ManageRoles)],
    ['members', 'Üyeler', hasPerm(perms, Perm.ManageRoles) || hasPerm(perms, Perm.KickMembers)],
    ['bans', 'Yasaklar', hasPerm(perms, Perm.BanMembers)],
  ];

  return (
    <Modal title={`${g.guild.name} — ayarlar`} onClose={onClose} wide>
      <div className="settings">
        <nav className="settings-nav">
          {tabs
            .filter(([, , visible]) => visible)
            .map(([key, label]) => (
              <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
        </nav>
        <div className="settings-pane">
          {tab === 'general' && <General guildId={guildId} onDeleted={onClose} />}
          {tab === 'roles' && <Roles guildId={guildId} />}
          {tab === 'members' && <Members guildId={guildId} />}
          {tab === 'bans' && <Bans guildId={guildId} />}
        </div>
      </div>
    </Modal>
  );
}

function General({ guildId, onDeleted }: { guildId: string; onDeleted: () => void }) {
  const g = useStore((s) => s.guilds[guildId])!;
  const me = useStore((s) => s.me)!;
  const [name, setName] = useState(g.guild.name);
  const [error, setError] = useState('');
  const canManage = hasPerm(guildPerms(getState(), guildId), Perm.ManageGuild);

  return (
    <div className="stack">
      <label>
        Sunucu adı
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} maxLength={100} />
      </label>
      {canManage && (
        <button className="primary" disabled={!name.trim() || name === g.guild.name} onClick={() => attempt(() => api.updateGuild(guildId, { name }), setError)}>
          Kaydet
        </button>
      )}
      {error && <div className="error">{error}</div>}
      {g.guild.ownerId === me.id && (
        <div className="danger-zone">
          <h3>Tehlikeli bölge</h3>
          <TransferOwnership guildId={guildId} onError={setError} />
          <p className="muted small">Sunucuyu silmek tüm kanalları ve mesajları kalıcı olarak siler.</p>
          <button
            className="danger"
            onClick={async () => {
              if (prompt(`Onaylamak için sunucu adını yaz: ${g.guild.name}`) !== g.guild.name) return;
              if (await attempt(() => api.deleteGuild(guildId), setError)) onDeleted();
            }}
          >
            Sunucuyu sil
          </button>
        </div>
      )}
    </div>
  );
}

// The owner hands the server to another member and becomes a regular member.
function TransferOwnership({ guildId, onError }: { guildId: string; onError: (e: string) => void }) {
  const g = useStore((s) => s.guilds[guildId])!;
  const me = useStore((s) => s.me)!;
  const [target, setTarget] = useState('');
  const others = g.members.filter((m) => m.userId !== me.id);
  if (others.length === 0) return null;
  return (
    <div className="row">
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Sahipliği devredeceğin üyeyi seç…</option>
        {others.map((m) => (
          <option key={m.userId} value={m.userId}>
            {displayName(getState(), m.userId, guildId)}
          </option>
        ))}
      </select>
      <button
        className="danger"
        disabled={!target}
        onClick={async () => {
          const name = displayName(getState(), target, guildId);
          if (!confirm(`"${g.guild.name}" sunucusunun sahipliği ${name} kişisine geçecek. Emin misin?`)) return;
          await attempt(() => api.updateGuild(guildId, { ownerId: target }), onError);
        }}
      >
        Sahipliği devret
      </button>
    </div>
  );
}

function Roles({ guildId }: { guildId: string }) {
  const roles = useStore((s) => s.guilds[guildId]?.roles) ?? [];
  const [selected, setSelected] = useState<string>(guildId);
  const [error, setError] = useState('');
  const role = roles.find((r) => r.id === selected) ?? roles[0];

  async function create() {
    await attempt(async () => {
      const r = await api.createRole(guildId, { name: 'yeni rol', color: '#1971c2', permissions: 0 });
      setSelected(r.id);
    }, setError);
  }

  return (
    <div className="roles">
      <div className="role-pick">
        <button className="primary small" onClick={create}>
          + Rol oluştur
        </button>
        {[...roles].reverse().map((r) => (
          <button key={r.id} className={role?.id === r.id ? 'active' : ''} onClick={() => setSelected(r.id)}>
            <span className="dot" style={{ background: r.color }} />
            {r.name}
          </button>
        ))}
      </div>
      {role && <RoleEditor key={role.id} guildId={guildId} role={role} onError={setError} />}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function RoleEditor({ guildId, role, onError }: { guildId: string; role: Role; onError: (e: string) => void }) {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color);
  const [perms, setPerms] = useState(role.permissions);
  const [saved, setSaved] = useState(false);
  const isEveryone = role.id === guildId;

  useEffect(() => setSaved(false), [name, color, perms]);

  return (
    <div className="stack role-editor">
      <div className="row">
        <label className="grow">
          Rol adı
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={isEveryone} maxLength={100} />
        </label>
        <label>
          Renk
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
      </div>
      <div className="perm-list">
        {(Object.keys(Perm) as PermName[]).map((key) => (
          <label key={key} className="check">
            <input
              type="checkbox"
              checked={(perms & Perm[key]) !== 0}
              onChange={(e) => setPerms(e.target.checked ? perms | Perm[key] : perms & ~Perm[key])}
            />
            {PERMISSION_LABELS[key]}
          </label>
        ))}
      </div>
      <div className="row-between">
        {!isEveryone ? (
          <button className="danger" onClick={() => confirm(`"${role.name}" rolü silinsin mi?`) && attempt(() => api.deleteRole(guildId, role.id), onError)}>
            Rolü sil
          </button>
        ) : (
          <span className="muted small">@everyone herkese uygulanan temel izinlerdir.</span>
        )}
        <div className="row">
          {saved && <span className="success-text small">Kaydedildi</span>}
          <button
            className="primary"
            onClick={async () => {
              const ok = await attempt(
                () => api.updateRole(guildId, role.id, { name: isEveryone ? undefined : name, color, permissions: perms }),
                onError,
              );
              setSaved(ok);
            }}
          >
            Kaydet
          </button>
        </div>
      </div>
    </div>
  );
}

function Members({ guildId }: { guildId: string }) {
  const g = useStore((s) => s.guilds[guildId])!;
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const [error, setError] = useState('');
  const perms = guildPerms(getState(), guildId);
  const assignable = g.roles.filter((r) => r.id !== guildId);

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}
      {g.members.map((m) => (
        <div key={m.userId} className="member-admin">
          <Avatar user={users[m.userId]} size={32} />
          <div className="grow">
            <strong>{displayName(getState(), m.userId, guildId)}</strong>
            {g.guild.ownerId === m.userId && <span className="muted small"> (sahip)</span>}
            {hasPerm(perms, Perm.ManageRoles) && (
              <div className="role-chips">
                {assignable.map((r) => {
                  const on = m.roleIds.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      className={`chip ${on ? 'on' : ''}`}
                      style={{ borderColor: r.color, background: on ? r.color : undefined }}
                      onClick={() =>
                        attempt(
                          () => api.updateMember(guildId, m.userId, { roleIds: on ? m.roleIds.filter((x) => x !== r.id) : [...m.roleIds, r.id] }),
                          setError,
                        )
                      }
                    >
                      {r.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {hasPerm(perms, Perm.KickMembers) && m.userId !== me.id && m.userId !== g.guild.ownerId && (
            <button className="danger" onClick={() => confirm('Bu üye sunucudan atılsın mı?') && attempt(() => api.kick(guildId, m.userId), setError)}>
              At
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// People banned from this server, with the reason; a ban can be lifted here.
function Bans({ guildId }: { guildId: string }) {
  const [list, setList] = useState<GuildBan[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api.guildBans(guildId).then(setList, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [guildId]);
  if (error) return <div className="error">{error}</div>;
  if (!list) return <p className="muted">Yükleniyor…</p>;
  if (list.length === 0) return <p className="muted">Bu sunucudan yasaklanmış kimse yok. Üye listesinde birine sağ tıklayıp yasaklayabilirsin.</p>;
  return (
    <div className="stack">
      {list.map((b) => (
        <div key={b.user.id} className="row-between">
          <span>
            <strong>{b.user.displayName}</strong> <span className="muted small">@{b.user.username}</span>
            {b.reason && <div className="muted small">{b.reason}</div>}
          </span>
          <button onClick={() => api.guildUnban(guildId, b.user.id).then(load, (e: Error) => setError(e.message))}>Yasağı kaldır</button>
        </div>
      ))}
    </div>
  );
}
