import { useState, type FormEvent } from 'react';
import { api } from '../../api';
import { navigate } from '../../actions';
import { getState, useStore } from '../../state';
import { attempt, Modal } from './Modal';

export function CreateGuildModal({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me);
  const [name, setName] = useState(`${me?.displayName ?? 'Benim'} sunucusu`);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    let guildId = '';
    const ok = await attempt(async () => {
      guildId = (await api.createGuild(name.trim())).guild.id;
    }, setError);
    if (ok) {
      // GUILD_CREATE may arrive just after the HTTP response; navigate once it is in state.
      const go = () => (getState().guilds[guildId] ? navigate(guildId) : setTimeout(go, 50));
      go();
      onClose();
    }
  }

  return (
    <Modal title="Sunucunu oluştur" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <p className="muted">Sunucun, sen ve arkadaşlarının takıldığı yer. Bir isim ver, sonra istediğin zaman değiştirebilirsin.</p>
        <label>
          Sunucu adı
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={!name.trim()}>
          Oluştur
        </button>
      </form>
    </Modal>
  );
}
