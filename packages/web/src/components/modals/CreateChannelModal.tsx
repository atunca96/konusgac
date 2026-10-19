import { useState, type FormEvent } from 'react';
import { api } from '../../api';
import { navigate } from '../../actions';
import { attempt, Modal } from './Modal';

type Kind = 'text' | 'voice' | 'category';

const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'text', label: '# Metin kanalı' },
  { kind: 'voice', label: '🔊 Sesli kanal' },
  { kind: 'category', label: '▤ Kategori' },
];

export function CreateChannelModal(props: { guildId: string; parentId: string | null; initialType?: Kind; onClose: () => void }) {
  const { guildId, parentId, onClose } = props;
  const [type, setType] = useState<Kind>(props.initialType ?? 'text');
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    let id = '';
    const ok = await attempt(async () => {
      id = (await api.createChannel(guildId, { name, type, parentId: type === 'category' ? null : parentId, topic: type === 'text' ? topic : '' })).id;
    }, setError);
    if (ok) {
      if (type === 'text') navigate(guildId, id);
      onClose();
    }
  }

  return (
    <Modal title={parentId ? 'Kategoriye kanal ekle' : 'Kanal oluştur'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <div className="segmented">
          {KINDS.filter((k) => !parentId || k.kind !== 'category').map((k) => (
            <button key={k.kind} type="button" className={type === k.kind ? 'active' : ''} onClick={() => setType(k.kind)}>
              {k.label}
            </button>
          ))}
        </div>
        <label>
          {type === 'category' ? 'Kategori adı' : 'Kanal adı'}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={100}
            placeholder={type === 'text' ? 'yeni-kanal' : type === 'voice' ? 'Sohbet Odası' : 'Yeni Kategori'}
          />
        </label>
        {type === 'text' && (
          <label>
            Konu (isteğe bağlı)
            <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={1024} />
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={!name.trim()}>
          Oluştur
        </button>
      </form>
    </Modal>
  );
}
