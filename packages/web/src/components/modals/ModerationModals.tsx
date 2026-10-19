import { REPORT_REASONS, type Message, type ReportReason } from '@konusgac/shared';
import { useState, type FormEvent } from 'react';
import { api } from '../../api';
import { displayName, getState } from '../../state';
import { attempt, Modal } from './Modal';

// "Mesajı şikâyet et": why, and an optional note. The platform's operators get it.
export function ReportModal({ message, onClose }: { message: Message; onClose: () => void }) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (reason && (await attempt(() => api.report(message.id, reason, note), setError))) setSent(true);
  }

  if (sent) {
    return (
      <Modal title="Şikâyet gönderildi" onClose={onClose}>
        <div className="stack">
          <p>Teşekkürler. Şikâyetin incelenecek; kurallara aykırıysa içerik kaldırılır.</p>
          <div className="row-between">
            <span />
            <button className="primary" onClick={onClose}>
              Tamam
            </button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Mesajı şikâyet et" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <blockquote className="report-quote">
          <strong>{displayName(getState(), message.authorId)}</strong>: {message.content || '📎 Ek'}
        </blockquote>
        <div className="set-radio">
          {(Object.keys(REPORT_REASONS) as ReportReason[]).map((r) => (
            <label key={r} className={reason === r ? 'active' : ''}>
              <input type="radio" name="reason" checked={reason === r} onChange={() => setReason(r)} />
              <span>{REPORT_REASONS[r]}</span>
            </label>
          ))}
        </div>
        <label>
          Not (isteğe bağlı)
          <textarea value={note} maxLength={1000} rows={3} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="row-between">
          <button type="button" onClick={onClose}>
            Vazgeç
          </button>
          <button className="danger-fill" disabled={!reason}>
            Şikâyet et
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Banning from a server (its moderators) or from the whole platform (its operators).
export function BanModal({ userId, guildId, onClose }: { userId: string; guildId?: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [cleanUp, setCleanUp] = useState(false);
  const [error, setError] = useState('');
  const name = displayName(getState(), userId, guildId);
  const platform = !guildId;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await attempt(
      () => (platform ? api.adminBan(userId, reason, cleanUp) : api.guildBan(guildId!, userId, reason)),
      setError,
    );
    if (ok) onClose();
  }

  return (
    <Modal title={platform ? `${name} platformdan yasaklansın mı?` : `${name} sunucudan yasaklansın mı?`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small">
          {platform
            ? 'Hesap kapatılır: tüm cihazlarda oturumu kapanır ve bir daha giriş yapamaz. Yasağı Platform yönetimi sayfasından kaldırabilirsin.'
            : 'Sunucudan çıkarılır ve davet bağlantılarıyla geri giremez. Yasağı sunucu ayarlarındaki Yasaklar sekmesinden kaldırabilirsin.'}
        </p>
        <label>
          Sebep (isteğe bağlı)
          <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </label>
        {platform && (
          <label className="context-check">
            <input type="checkbox" checked={cleanUp} onChange={(e) => setCleanUp(e.target.checked)} /> Son 24 saatteki mesajlarını da sil
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row-between">
          <button type="button" onClick={onClose}>
            Vazgeç
          </button>
          <button className="danger-fill">Yasakla</button>
        </div>
      </form>
    </Modal>
  );
}
