import { useState, type FormEvent } from 'react';
import { openMenu } from '../menu';
import { userMenu } from '../menus';
import { api } from '../api';
import { openDmWith } from '../actions';
import { useStore } from '../state';
import { Avatar } from './Avatar';

type Tab = 'online' | 'all' | 'pending' | 'add';

export function Friends() {
  const relationships = useStore((s) => s.relationships);
  const users = useStore((s) => s.users);
  const presences = useStore((s) => s.presences);
  const [tab, setTab] = useState<Tab>('online');

  const entries = Object.entries(relationships);
  const friends = entries.filter(([, t]) => t === 'friend').map(([id]) => id);
  const pending = entries.filter(([, t]) => t !== 'friend');
  const list = tab === 'online' ? friends.filter((id) => presences[id] === 'online') : friends;

  const tabs: [Tab, string][] = [
    ['online', 'Çevrimiçi'],
    ['all', 'Tümü'],
    ['pending', `Bekleyen${pending.length ? ` (${pending.length})` : ''}`],
  ];

  return (
    <div className="friends">
      <header className="chat-header">
        <strong>☺ Arkadaşlar</strong>
        {tabs.map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
        <button className={`tab add ${tab === 'add' ? 'active' : ''}`} onClick={() => setTab('add')}>
          Arkadaş ekle
        </button>
      </header>

      <div className="friends-body">
        {tab === 'add' && <AddFriend />}

        {(tab === 'online' || tab === 'all') && (
          <>
            <div className="section-title">
              {tab === 'online' ? 'Çevrimiçi' : 'Tüm arkadaşlar'} — {list.length}
            </div>
            {list.length === 0 && <p className="muted pad">Burada kimse yok. Arkadaş eklemek için "Arkadaş ekle" sekmesini kullan.</p>}
            {list.map((id) => (
              <div key={id} className="friend-row" onContextMenu={(e) => openMenu(e, userMenu(id))}>
                <Avatar user={users[id]} size={36} status={presences[id] ?? 'offline'} />
                <div className="friend-names">
                  <strong>{users[id]?.displayName}</strong>
                  <span className="muted small">@{users[id]?.username}</span>
                </div>
                <button onClick={() => void openDmWith(id)}>Mesaj</button>
                <button
                  className="danger"
                  onClick={() => confirm(`${users[id]?.displayName} arkadaşlıktan çıkarılsın mı?`) && void api.removeRelationship(id)}
                >
                  Çıkar
                </button>
              </div>
            ))}
          </>
        )}

        {tab === 'pending' && (
          <>
            <div className="section-title">Bekleyen — {pending.length}</div>
            {pending.length === 0 && <p className="muted pad">Bekleyen arkadaşlık isteği yok.</p>}
            {pending.map(([id, type]) => (
              <div key={id} className="friend-row" onContextMenu={(e) => openMenu(e, userMenu(id))}>
                <Avatar user={users[id]} size={36} />
                <div className="friend-names">
                  <strong>{users[id]?.displayName}</strong>
                  <span className="muted small">{type === 'incoming' ? 'Gelen arkadaşlık isteği' : 'Giden arkadaşlık isteği'}</span>
                </div>
                {type === 'incoming' && (
                  <button className="primary" onClick={() => void api.addFriend({ userId: id })}>
                    Kabul et
                  </button>
                )}
                <button className="danger" onClick={() => void api.removeRelationship(id)}>
                  {type === 'incoming' ? 'Reddet' : 'İptal et'}
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function AddFriend() {
  const [username, setUsername] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.addFriend({ username: username.trim() });
      setResult({ ok: true, text: `${username} kullanıcısına arkadaşlık isteği gönderildi.` });
      setUsername('');
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    }
  }

  return (
    <form className="add-friend" onSubmit={submit}>
      <h3>Arkadaş ekle</h3>
      <p className="muted">Kullanıcı adını yazarak arkadaşlık isteği gönderebilirsin.</p>
      <div className="inline-form">
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="kullanici_adi" />
        <button className="primary" disabled={!username.trim()}>
          İstek gönder
        </button>
      </div>
      {result && <div className={result.ok ? 'success-text' : 'error-text'}>{result.text}</div>}
    </form>
  );
}
