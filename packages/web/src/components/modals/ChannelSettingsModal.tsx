import { Perm, PERMISSION_LABELS, type Channel, type PermissionOverwrite } from '@konusgac/shared';
import { useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../state';
import { attempt, Modal } from './Modal';

// Permissions that make sense to override per channel type.
const TEXT_PERMS = ['ViewChannel', 'SendMessages', 'ReadHistory', 'ManageMessages'] as const;
const VOICE_PERMS = ['ViewChannel', 'Connect', 'Speak'] as const;

type Tri = 'allow' | 'inherit' | 'deny';

function triOf(ow: PermissionOverwrite | undefined, bit: number): Tri {
  if (!ow) return 'inherit';
  if (ow.allow & bit) return 'allow';
  if (ow.deny & bit) return 'deny';
  return 'inherit';
}

export function ChannelSettingsModal({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const roles = useStore((s) => s.guilds[channel.guildId!]?.roles) ?? [];
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic);
  const [overwrites, setOverwrites] = useState<PermissionOverwrite[]>(channel.overwrites);
  const [roleId, setRoleId] = useState(channel.guildId!); // @everyone
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const current = overwrites.find((o) => o.roleId === roleId);

  function setTri(bit: number, value: Tri) {
    const base = current ?? { roleId, allow: 0, deny: 0 };
    const next = {
      roleId,
      allow: value === 'allow' ? base.allow | bit : base.allow & ~bit,
      deny: value === 'deny' ? base.deny | bit : base.deny & ~bit,
    };
    const rest = overwrites.filter((o) => o.roleId !== roleId);
    setOverwrites(next.allow || next.deny ? [...rest, next] : rest);
    setSaved(false);
  }

  async function save() {
    const ok = await attempt(
      () =>
        api.updateChannel(channel.id, {
          name: name !== channel.name ? name : undefined,
          topic: channel.type === 'text' && topic !== channel.topic ? topic : undefined,
          overwrites,
        }),
      setError,
    );
    setSaved(ok);
  }

  async function remove() {
    if (!confirm(`"${channel.name}" ${channel.type === 'category' ? 'kategorisi' : 'kanalı'} silinsin mi? Bu işlem geri alınamaz.`)) return;
    if (await attempt(() => api.deleteChannel(channel.id), setError)) onClose();
  }

  return (
    <Modal
      title={channel.type === 'category' ? 'Kategori ayarları' : channel.type === 'voice' ? `🔊 ${channel.name} ayarları` : `#${channel.name} ayarları`}
      onClose={onClose}
      wide
    >
      <div className="stack">
        <label>
          Ad
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </label>
        {channel.type === 'text' && (
          <label>
            Konu
            <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={1024} />
          </label>
        )}

        <h3>İzinler</h3>
        <p className="muted small">Bir rol seç ve bu {channel.type === 'category' ? 'kategoride' : 'kanalda'} hangi izinlerin verileceğini veya engelleneceğini ayarla.</p>
        <div className="perm-editor">
          <div className="role-pick">
            {[...roles].reverse().map((r) => (
              <button key={r.id} className={roleId === r.id ? 'active' : ''} onClick={() => setRoleId(r.id)}>
                <span className="dot" style={{ background: r.color }} />
                {r.name}
                {overwrites.some((o) => o.roleId === r.id) && <span className="muted small"> •</span>}
              </button>
            ))}
          </div>
          <div className="perm-rows">
            {(channel.type === 'voice' ? VOICE_PERMS : TEXT_PERMS).map((key) => {
              const bit = Perm[key];
              const value = triOf(current, bit);
              return (
                <div key={key} className="perm-row">
                  <span>{PERMISSION_LABELS[key]}</span>
                  <div className="tri">
                    <button className={value === 'deny' ? 'deny active' : 'deny'} title="Engelle" onClick={() => setTri(bit, 'deny')}>
                      ✕
                    </button>
                    <button className={value === 'inherit' ? 'active' : ''} title="Rolden devral" onClick={() => setTri(bit, 'inherit')}>
                      /
                    </button>
                    <button className={value === 'allow' ? 'allow active' : 'allow'} title="İzin ver" onClick={() => setTri(bit, 'allow')}>
                      ✓
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {error && <div className="error">{error}</div>}
        <div className="row-between">
          <button className="danger" onClick={remove}>
            {channel.type === 'category' ? 'Kategoriyi sil' : 'Kanalı sil'}
          </button>
          <div className="row">
            {saved && <span className="success-text small">Kaydedildi</span>}
            <button className="primary" onClick={save}>
              Değişiklikleri kaydet
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
