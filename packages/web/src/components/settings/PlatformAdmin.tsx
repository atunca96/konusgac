import { REPORT_REASONS, type PlatformBan, type Report } from '@konusgac/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { channelLink } from '../../menus';
import { openDialog } from '../../ui';
import { Avatar } from '../Avatar';

const when = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });

// Ayarlar → Platform yönetimi, for the people who run this server: reports, platform bans.
export function PlatformAdminPage() {
  const [tab, setTab] = useState<'open' | 'resolved' | 'bans'>('open');
  return (
    <>
      <h2>Platform yönetimi</h2>
      <p className="set-note">
        Şikâyet edilen içerikleri incele, kurallara aykırı olanları kaldır, gerekirse hesabı kapat. Şikâyet edilen mesajın bir
        kopyası, mesaj silinse bile burada kalır.
      </p>
      <div className="segmented" style={{ alignSelf: 'flex-start', margin: '12px 0' }}>
        <button className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>
          Açık şikâyetler
        </button>
        <button className={tab === 'resolved' ? 'active' : ''} onClick={() => setTab('resolved')}>
          Çözülenler
        </button>
        <button className={tab === 'bans' ? 'active' : ''} onClick={() => setTab('bans')}>
          Yasaklı hesaplar
        </button>
      </div>
      {tab === 'bans' ? <Bans /> : <Reports status={tab} key={tab} />}
    </>
  );
}

function Reports({ status }: { status: 'open' | 'resolved' }) {
  const [list, setList] = useState<Report[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api.adminReports(status).then(setList, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const act = (fn: () => Promise<unknown>) => fn().then(load, (e: Error) => setError(e.message));

  if (error) return <div className="error">{error}</div>;
  if (!list) return <p className="muted">Yükleniyor…</p>;
  if (list.length === 0) return <p className="muted">{status === 'open' ? 'Açık şikâyet yok.' : 'Çözülmüş şikâyet yok.'}</p>;
  return (
    <div className="report-list">
      {list.map((r) => (
        <div key={r.id} className="report-card">
          <div className="row-between">
            <strong className="report-reason">{REPORT_REASONS[r.reason]}</strong>
            <span className="muted small">{when.format(r.createdAt)}</span>
          </div>
          <div className="report-quote">
            <span className="row" style={{ gap: 8 }}>
              <Avatar user={r.author ?? undefined} size={20} />
              <strong>{r.author?.displayName ?? 'Bilinmeyen'}</strong>
              <span className="muted small">@{r.author?.username}</span>
            </span>
            <div>{r.content || <span className="muted">(metin yok)</span>}</div>
            {r.attachments.length > 0 && <div className="muted small">📎 {r.attachments.join(', ')}</div>}
          </div>
          <div className="muted small">
            {r.guildName ? `${r.guildName} · #${r.channelName ?? '?'}` : 'Özel mesaj'} · Şikâyet eden: @{r.reporter?.username ?? '?'}
            {!r.messageExists && ' · mesaj silinmiş'}
          </div>
          {r.note && <div className="small">Not: {r.note}</div>}
          {status === 'open' && (
            <div className="row report-actions">
              {r.messageExists && r.messageId && (
                <button
                  onClick={() => {
                    location.hash = new URL(channelLink({ id: r.channelId, guildId: r.guildId } as never, r.messageId!)).hash;
                    openDialog(null);
                  }}
                >
                  Mesaja git
                </button>
              )}
              {r.messageExists && r.messageId && (
                <button className="danger" onClick={() => confirm('Mesaj silinsin mi?') && act(() => api.adminDeleteMessage(r.messageId!))}>
                  Mesajı sil
                </button>
              )}
              {r.author && (
                <button className="danger" onClick={() => openDialog({ kind: 'ban', userId: r.author!.id })}>
                  Hesabı kapat
                </button>
              )}
              <button className="primary" onClick={() => act(() => api.adminResolveReport(r.id))}>
                Çözüldü
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Bans() {
  const [list, setList] = useState<PlatformBan[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api.adminBans().then(setList, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  if (error) return <div className="error">{error}</div>;
  if (!list) return <p className="muted">Yükleniyor…</p>;
  if (list.length === 0) return <p className="muted">Yasaklı hesap yok.</p>;
  return (
    <div className="report-list">
      {list.map((b) => (
        <div key={b.user.id} className="report-card row-between">
          <span className="row" style={{ gap: 10 }}>
            <Avatar user={b.user} size={32} />
            <span>
              <strong>{b.user.displayName}</strong> <span className="muted small">@{b.user.username}</span>
              <div className="muted small">
                {when.format(b.bannedAt)}
                {b.reason && ` · ${b.reason}`}
              </div>
            </span>
          </span>
          <button onClick={() => confirm('Yasak kaldırılsın mı?') && api.adminUnban(b.user.id).then(load, (e: Error) => setError(e.message))}>
            Yasağı kaldır
          </button>
        </div>
      ))}
    </div>
  );
}
