import { LIMITS } from '@konusgac/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { startSession } from '../actions';
import { DOWNLOAD_URL, useDesktopDownload } from '../download';
import { finishReset, showNotice, useNotice, useResetToken } from '../links';
import { desktop } from '../notify';

type Mode = 'login' | 'register' | 'forgot' | 'reset';

interface ServerInfo {
  registration: 'open' | 'closed';
  mail: boolean;
  google: boolean;
}

export function Auth() {
  const resetToken = useResetToken();
  const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : 'login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<ServerInfo>({ registration: 'open', mail: false, google: false });
  const offerApp = useDesktopDownload();
  const notice = useNotice();

  useEffect(() => {
    api.config().then((c) => setInfo({ registration: c.registration, mail: !!c.mail, google: !!c.google }), () => {});
  }, []);
  useEffect(() => {
    if (resetToken) setMode('reset');
  }, [resetToken]);

  const go = (m: Mode) => {
    setMode(m);
    setError('');
    setSent(false);
    showNotice(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'forgot') {
        await api.forgotPassword(email);
        setSent(true);
      } else if (mode === 'reset') {
        await api.resetPassword(resetToken!, password);
        finishReset();
        setPassword('');
        setMode('login');
        showNotice({ kind: 'success', text: 'Yeni şifren kaydedildi. Şimdi onunla giriş yapabilirsin.' });
      } else {
        const res =
          mode === 'login'
            ? await api.login(username, password)
            : await api.register(username, password, displayName || username, info.mail ? email : undefined);
        startSession(res.token);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Google refuses sign-in inside apps, so the desktop app sends it to the system browser and
  // gets the result back through konusgac://.
  const google = () => {
    if (desktop?.openGoogleSignIn) desktop.openGoogleSignIn();
    else location.href = '/api/auth/google';
  };

  const titles: Record<Mode, [string, string]> = {
    login: ['Tekrar hoş geldin!', 'Konuşgaç hesabınla giriş yap.'],
    register: ['Hesap oluştur', 'Birkaç saniyede aramıza katıl.'],
    forgot: ['Şifreni mi unuttun?', 'Hesabının e-posta adresini yaz, sana yeni şifre bağlantısı gönderelim.'],
    reset: ['Yeni şifre belirle', 'Hesabın için yeni bir şifre seç.'],
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <img src="/logo.svg" alt="" className="auth-logo" />
        <h1>{titles[mode][0]}</h1>
        <p className="muted">{titles[mode][1]}</p>
        {notice && <div className={notice.kind === 'error' ? 'error' : 'notice-ok'}>{notice.text}</div>}

        {(mode === 'login' || mode === 'register') && info.google && (
          <>
            <button type="button" className="google-btn" onClick={google}>
              <GoogleLogo /> Google ile devam et
            </button>
            <p className="muted small center legal-note">
              Google ile devam ederek{' '}
              <a href="/kosullar" target="_blank" rel="noreferrer">
                Kullanım Koşulları
              </a>
              'nı ve{' '}
              <a href="/gizlilik" target="_blank" rel="noreferrer">
                Gizlilik Politikası
              </a>
              'nı kabul etmiş olursun.
            </p>
            <div className="auth-or">
              <span>ya da</span>
            </div>
          </>
        )}

        {mode === 'forgot' && sent ? (
          <p className="notice-ok">Bu adresle bir hesap varsa şifre sıfırlama bağlantısı gönderildi. Gelen kutunu (ve gereksiz klasörünü) kontrol et.</p>
        ) : (
          <>
            {(mode === 'login' || mode === 'register') && (
              <label>
                {mode === 'login' ? (info.mail ? 'Kullanıcı adı ya da e-posta' : 'Kullanıcı adı') : 'Kullanıcı adı'}
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required autoComplete="username" />
              </label>
            )}
            {((mode === 'register' && info.mail) || mode === 'forgot') && (
              <label>
                E-posta
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus={mode === 'forgot'} />
              </label>
            )}
            {mode === 'register' && (
              <label>
                Görünen ad
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={username} />
              </label>
            )}
            {mode !== 'forgot' && (
              <label>
                {mode === 'reset' ? 'Yeni şifre' : 'Şifre'}
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === 'login' ? undefined : LIMITS.passwordMin}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  autoFocus={mode === 'reset'}
                />
              </label>
            )}
            {mode === 'register' && (
              <label className="terms-check">
                <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} required />
                <span>
                  <a href="/kosullar" target="_blank" rel="noreferrer">
                    Kullanım Koşulları
                  </a>
                  'nı ve{' '}
                  <a href="/gizlilik" target="_blank" rel="noreferrer">
                    Gizlilik Politikası
                  </a>
                  'nı okudum, kabul ediyorum. 13 yaşından büyüğüm.
                </span>
              </label>
            )}
            {mode === 'login' && info.mail && (
              <button type="button" className="link forgot-link" onClick={() => go('forgot')}>
                Şifreni mi unuttun?
              </button>
            )}

            {error && <div className="error">{error}</div>}
            <button className="primary" disabled={busy || (mode === 'register' && !accepted)}>
              {{ login: 'Giriş yap', register: 'Kayıt ol', forgot: 'Bağlantı gönder', reset: 'Şifreyi kaydet' }[mode]}
            </button>
          </>
        )}

        {mode === 'login' && info.registration === 'closed' ? (
          <p className="muted small center">Bu sunucu yeni hesap kabul etmiyor.</p>
        ) : (
          <button type="button" className="link" onClick={() => go(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Hesabın yok mu? Kayıt ol' : mode === 'register' ? 'Zaten hesabın var mı? Giriş yap' : 'Girişe dön'}
          </button>
        )}
        {offerApp && (
          <a className="download-app" href={DOWNLOAD_URL}>
            ⬇ Windows uygulamasını indir
          </a>
        )}
        <p className="muted small center legal-links">
          <a href="/kosullar" target="_blank" rel="noreferrer">
            Kullanım Koşulları
          </a>
          {' · '}
          <a href="/gizlilik" target="_blank" rel="noreferrer">
            Gizlilik Politikası
          </a>
        </p>
      </form>
    </div>
  );
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
