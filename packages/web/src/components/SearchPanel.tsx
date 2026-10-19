import type { Message } from '@konusgac/shared';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { channelById, displayName, getState, useStore } from '../state';
import { Avatar } from './Avatar';
import { RichText } from './Chat';

const when = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// Searches the current server (or DM), newest first, 25 results per page.
export function SearchPanel(props: {
  scope: { guildId?: string; channelId?: string };
  onClose: () => void;
  onOpen: (m: Message) => void;
}) {
  const me = useStore((s) => s.me)!;
  const users = useStore((s) => s.users);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lastQuery = useRef('');

  async function run(more = false) {
    const q = more ? lastQuery.current : query.trim();
    if (!q) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.search(q, props.scope, more ? results?.at(-1)?.id : undefined);
      lastQuery.current = q;
      setResults(more ? [...(results ?? []), ...res.messages] : res.messages);
      setHasMore(res.hasMore);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const s = getState();
  return (
    <aside className="search-panel">
      <form
        className="search-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void run();
        }}
      >
        <input autoFocus placeholder="Ara…" value={query} maxLength={200} onChange={(e) => setQuery(e.target.value)} />
        <button className="icon-btn" type="button" title="Kapat" onClick={props.onClose}>
          ✕
        </button>
      </form>
      <div className="search-results">
        {error && <div className="error-text small pad">{error}</div>}
        {results && results.length === 0 && <p className="muted pad">Sonuç bulunamadı.</p>}
        {results?.map((m) => {
          const channel = channelById(s, m.channelId);
          const guildId = channel?.guildId ?? undefined;
          return (
            <button key={m.id} className="search-hit" onClick={() => props.onOpen(m)}>
              <div className="search-hit-head">
                <Avatar user={users[m.authorId]} size={20} />
                <strong>{displayName(s, m.authorId, guildId)}</strong>
                {channel && channel.type !== 'dm' && <span className="muted small">#{channel.name}</span>}
                <span className="muted small">{when.format(m.createdAt)}</span>
              </div>
              <div className="search-hit-body">
                <RichText text={m.content || (m.attachments.length ? '📎 Ek' : '')} guildId={guildId} meId={me.id} />
              </div>
            </button>
          );
        })}
        {hasMore && (
          <button className="link pad" disabled={busy} onClick={() => void run(true)}>
            Daha fazla göster
          </button>
        )}
        {busy && <p className="muted small pad">Aranıyor…</p>}
      </div>
    </aside>
  );
}
