import { LIMITS } from '@konusgac/shared';
import { useEffect, useState } from 'react';
import { api, type Account } from '../../api';
import { logout } from '../../actions';
import { desktop } from '../../notify';
import { useSettings } from '../../settings';
import { useStore } from '../../state';
import { Avatar } from '../Avatar';
import { attempt, Modal } from './Modal';

export function UserSettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Hesabım" onClose={onClose}>
      <div className="stack">
        <Profile />
        <hr />
        <PasswordForm />
        <hr />
        <DeleteAccount />
        <DesktopServer />
      </div>
    </Modal>
  );
}

export function Profile() {
  const me = useStore((s) => s.me)!;
  const [displayName, setDisplayName] = useState(me.displayName);
  const [color, setColor] = useState(me.avatarColor);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  return (
    <>
      <div className="row">
        <Avatar user={{ ...me, displayName, avatarColor: color }} size={64} />
        <div>
          <strong>{displayName}</strong>
          <div className="muted">@{me.username}</div>
        </div>
      </div>
      <label>
        Görünen ad
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={LIMITS.displayNameMax} />
      </label>
      <label>
        Profil rengi
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="row-between">
        <button className="danger" onClick={() => void logout()}>
          Çıkış yap
        </button>
        <div className="row">
          {saved && <span className="success-text small">Kaydedildi</span>}
          <button
            className="primary"
            disabled={!displayName.trim()}
            onClick={async () => setSaved(await attempt(() => api.updateMe({ displayName: displayName.trim(), avatarColor: color }), setError))}
          >
            Kaydet
          </button>
        </div>
      </div>
    </>
  );
}

// E-mail address: shown with its state; change it (confirmed again by mail) or resend the link.
export function EmailSection() {
  const [account, setAccount] = useState<Account | null>(null);
  const [mail, setMail] = useState(false);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const streamer = useSettings((s) => s.streamerMode);
  useEffect(() => {
    api.account().then(setAccount, (e: Error) => setError(e.message));
    api.config().then((c) => setMail(!!c.mail), () => {});
  }, []);
  if (!account) return error ? <div className="error">{error}</div> : null;
  const shown = account.email ? (streamer ? account.email.replace(/^(.).*(@.*)$/, '$1•••$2') : account.email) : 'Eklenmemiş';

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <div className="set-label">E-posta</div>
          <div className="muted small">
            {shown}{' '}
            {account.email && (account.emailVerified ? <span className="success-text">· doğrulandı</span> : <span className="warn-text">· doğrulanmadı</span>)}
            {account.google && <span> · Google ile bağlı</span>}
          </div>
        </div>
        <button onClick={() => setEditing(!editing)}>{account.email ? 'Değiştir' : 'Ekle'}</button>
      </div>
      {account.email && !account.emailVerified && mail && (
        <div className="row-between">
          <span className="muted small">{note || 'Doğrulama bağlantısı e-postana gönderildi.'}</span>
          <button onClick={() => attempt(() => api.resendVerification(), setError).then((ok) => ok && setNote('Yeni bağlantı gönderildi.'))}>
            Tekrar gönder
          </button>
        </div>
      )}
      {editing && (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            await attempt(async () => {
              setAccount(await api.setEmail(address, password || undefined));
              setEditing(false);
              setPassword('');
              setNote(mail ? 'Yeni adresine doğrulama bağlantısı gönderildi.' : '');
            }, setError);
          }}
        >
          <label>
            Yeni e-posta
            <input type="email" value={address} onChange={(e) => setAddress(e.target.value)} required autoComplete="email" />
          </label>
          {account.hasPassword && (
            <label>
              Mevcut şifre
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
            </label>
          )}
          <div className="row-between">
            <button type="button" onClick={() => setEditing(false)}>
              Vazgeç
            </button>
            <button className="primary">Kaydet</button>
          </div>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function PasswordForm() {
  const [hasPassword, setHasPassword] = useState(true);
  useEffect(() => {
    api.account().then((a) => setHasPassword(a.hasPassword), () => {});
  }, []);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await attempt(() => api.changePassword(current, next), setError);
        setDone(ok);
        if (ok) {
          setCurrent('');
          setNext('');
          setHasPassword(true);
        }
      }}
    >
      <h3>{hasPassword ? 'Şifre değiştir' : 'Şifre belirle'}</h3>
      {!hasPassword && <p className="muted small">Hesabın Google ile açıldı. Bir şifre belirlersen kullanıcı adınla da giriş yapabilirsin.</p>}
      {hasPassword && (
        <label>
          Mevcut şifre
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
      )}
      <label>
        Yeni şifre <span className="muted small">(en az {LIMITS.passwordMin} karakter)</span>
        <input
          type="password"
          autoComplete="new-password"
          value={next}
          minLength={LIMITS.passwordMin}
          maxLength={LIMITS.passwordMax}
          onChange={(e) => setNext(e.target.value)}
          required
        />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="row-between">
        <span className="muted small">{done ? 'Şifren değişti; diğer cihazlardaki oturumlar kapatıldı.' : 'Değişince diğer cihazlarda çıkış yapılır.'}</span>
        <button className="primary" disabled={(hasPassword && !current) || next.length < LIMITS.passwordMin}>
          {hasPassword ? 'Şifreyi değiştir' : 'Şifreyi kaydet'}
        </button>
      </div>
    </form>
  );
}

export function DeleteAccount() {
  const [hasPassword, setHasPassword] = useState(true);
  useEffect(() => {
    api.account().then((a) => setHasPassword(a.hasPassword), () => {});
  }, []);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  if (!open) {
    return (
      <div className="row-between">
        <span className="muted small">Hesabını ve kişisel verilerini kalıcı olarak silebilirsin.</span>
        <button className="danger" onClick={() => setOpen(true)}>
          Hesabı sil
        </button>
      </div>
    );
  }
  return (
    <form
      className="stack danger-zone"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!confirm('Hesabın kalıcı olarak silinecek. Emin misin?')) return;
        if (await attempt(() => api.deleteAccount(password), setError)) void logout();
      }}
    >
      <h3>Hesabı sil</h3>
      <p className="small">
        Tüm sunuculardan çıkarılırsın; arkadaşlıkların, tepkilerin ve oturumların silinir, adın "Silinmiş kullanıcı" olur.
        Yazdığın mesajlar sohbetler okunabilir kalsın diye bu adla durur. Sahibi olduğun sunucuları önce devretmen ya da silmen gerekir.
      </p>
      <label>
        {hasPassword ? 'Onay için şifren' : 'Onay için kullanıcı adın'}
        <input
          type={hasPassword ? 'password' : 'text'}
          autoComplete={hasPassword ? 'current-password' : 'off'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="row-between">
        <button type="button" onClick={() => setOpen(false)}>
          Vazgeç
        </button>
        <button className="danger" disabled={!password}>
          Hesabımı kalıcı olarak sil
        </button>
      </div>
    </form>
  );
}

// Installed desktop app: show the server it connects to and let the user switch.
export function DesktopServer() {
  const [info, setInfo] = useState<{ version: string; canChangeServer: boolean; server: string | null } | null>(null);
  useEffect(() => {
    desktop?.info?.().then(setInfo, () => {});
  }, []);
  if (!info?.canChangeServer) return null;
  return (
    <>
      <hr />
      <div className="row-between">
        <span className="muted small">
          Sunucu: {info.server} · Konuşgaç {info.version}
        </span>
        <button onClick={() => desktop?.changeServer?.()}>Başka sunucuya bağlan</button>
      </div>
    </>
  );
}
