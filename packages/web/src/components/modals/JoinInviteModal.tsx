import type { InvitePreview } from '@konusgac/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { navigate } from '../../actions';
import { attempt, Modal } from './Modal';

// Accepts a bare code or a full ".../davet/<code>" link.
function parseCode(input: string) {
  const trimmed = input.trim();
  return trimmed.match(/davet\/([\w-]+)/)?.[1] ?? trimmed;
}

export function JoinInviteModal({ onClose, initialCode = '' }: { onClose: () => void; initialCode?: string }) {
  const [input, setInput] = useState(initialCode);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setPreview(null);
    const code = parseCode(input);
    if (code.length < 4) return;
    const t = setTimeout(() => {
      api.previewInvite(code).then(setPreview, (e) => setError((e as Error).message));
    }, 300);
    return () => clearTimeout(t);
  }, [input]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    let guildId = '';
    const ok = await attempt(async () => {
      guildId = (await api.joinInvite(parseCode(input))).guild.id;
    }, setError);
    if (ok) {
      navigate(guildId);
      onClose();
    }
  }

  return (
    <Modal title="Bir sunucuya katıl" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label>
          Davet bağlantısı veya kodu
          <input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError('');
            }}
            placeholder="http://…/davet/AbC123 veya AbC123"
            autoFocus
          />
        </label>
        {preview && (
          <div className="invite-preview">
            <span className="guild-icon" style={{ background: preview.guild.iconColor }}>
              {preview.guild.name.charAt(0).toLocaleUpperCase('tr')}
            </span>
            <div>
              <strong>{preview.guild.name}</strong>
              <div className="muted small">{preview.memberCount} üye</div>
            </div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={!input.trim()}>
          Sunucuya katıl
        </button>
      </form>
    </Modal>
  );
}
