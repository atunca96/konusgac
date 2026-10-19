import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useSettings } from '../../settings';
import { Modal } from './Modal';

export function InviteModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const streamer = useSettings((x) => x.streamerMode);

  useEffect(() => {
    api.createInvite(channelId).then(
      (inv) => setLink(`${location.origin}/davet/${inv.code}`),
      (e) => setError((e as Error).message),
    );
  }, [channelId]);

  async function copy() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal title="Arkadaşlarını davet et" onClose={onClose}>
      <div className="stack">
        <p className="muted">Bu bağlantıyı paylaş. Bağlantı 7 gün geçerli.</p>
        {error && <div className="error">{error}</div>}
        <div className="inline-form">
          <input readOnly value={!link ? 'Oluşturuluyor…' : streamer ? '•••••••• (yayıncı modu)' : link} onFocus={(e) => e.target.select()} />
          <button className="primary" onClick={copy} disabled={!link}>
            {copied ? 'Kopyalandı' : 'Kopyala'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
