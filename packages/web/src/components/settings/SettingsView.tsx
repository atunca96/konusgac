import type { PrivacySettings, Session } from '@konusgac/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { logout } from '../../actions';
import { desktop, type WindowSettings } from '../../notify';
import { DEFAULT_SETTINGS, resetSettings, updateSettings, useSettings, type Settings, type SoundName, type Theme } from '../../settings';
import { playSound, SOUND_LABELS } from '../../sounds';
import { DeleteAccount, DesktopServer, EmailSection, PasswordForm, Profile } from '../modals/UserSettingsModal';
import { KeyRecorder, Radio, Section, Slider, Toggle } from './controls';
import { VoiceSettings } from './VoiceSettings';
import { PlatformAdminPage } from './PlatformAdmin';
import { useSiteAdmin } from '../../admin';

type Page =
  | 'account'
  | 'privacy'
  | 'devices'
  | 'voice'
  | 'notifications'
  | 'keybinds'
  | 'appearance'
  | 'accessibility'
  | 'text'
  | 'windows'
  | 'streamer'
  | 'advanced'
  | 'admin';

const NAV: { title: string; items: [Page, string][] }[] = [
  {
    title: 'Kullanıcı ayarları',
    items: [
      ['account', 'Hesabım'],
      ['privacy', 'Gizlilik ve Güvenlik'],
      ['devices', 'Cihazlar'],
    ],
  },
  {
    title: 'Uygulama ayarları',
    items: [
      ['voice', 'Ses ve Görüntü'],
      ['notifications', 'Bildirimler'],
      ['keybinds', 'Tuş Atamaları'],
      ['appearance', 'Görünüm'],
      ['accessibility', 'Erişilebilirlik'],
      ['text', 'Metin ve Görseller'],
      ['windows', 'Windows Ayarları'],
      ['streamer', 'Yayıncı Modu'],
      ['advanced', 'Gelişmiş'],
    ],
  },
];

// Full-screen settings, opened from the gear in the user panel. Esc closes.
export function SettingsView({ onClose, initial = 'account' }: { onClose: () => void; initial?: Page }) {
  const [page, setPage] = useState<Page>(initial);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.key-recorder.recording') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pages: Record<Page, ReactNode> = {
    account: <AccountPage />,
    privacy: <PrivacyPage />,
    devices: <DevicesPage />,
    voice: <VoiceSettings />,
    notifications: <NotificationsPage />,
    keybinds: <KeybindsPage />,
    appearance: <AppearancePage />,
    accessibility: <AccessibilityPage />,
    text: <TextPage />,
    windows: <WindowsPage />,
    streamer: <StreamerPage />,
    advanced: <AdvancedPage />,
    admin: <PlatformAdminPage />,
  };
  const admin = useSiteAdmin();
  const nav = admin ? [...NAV, { title: 'Yönetim', items: [['admin', 'Platform yönetimi']] as [Page, string][] }] : NAV;

  return (
    <div className="settings-view" role="dialog" aria-label="Ayarlar">
      <nav className="settings-side">
        <div className="settings-side-inner">
          {nav.map((group) => (
            <div key={group.title}>
              <div className="settings-side-title">{group.title}</div>
              {group.items
                .filter(([key]) => key !== 'windows' || !!desktop?.getWindowSettings)
                .map(([key, label]) => (
                  <button key={key} className={page === key ? 'active' : ''} onClick={() => setPage(key)}>
                    {label}
                  </button>
                ))}
            </div>
          ))}
          <div className="settings-side-sep" />
          <button className="danger-text" onClick={() => void logout()}>
            Çıkış yap
          </button>
          <div className="settings-side-version">Konuşgaç 0.9.0</div>
        </div>
      </nav>
      <main className="settings-content">
        <div className="settings-page">{pages[page]}</div>
        <button className="settings-close" onClick={onClose} title="Kapat (Esc)">
          ✕<span>ESC</span>
        </button>
      </main>
    </div>
  );
}

const set = (patch: Partial<Settings>) => updateSettings(patch);

function AccountPage() {
  return (
    <>
      <h2>Hesabım</h2>
      <Section title="Profil">
        <Profile />
      </Section>
      <Section title="E-posta">
        <EmailSection />
      </Section>
      <Section title="Şifre ve kimlik doğrulama">
        <PasswordForm />
      </Section>
      <Section title="Hesabı kaldırma">
        <DeleteAccount />
      </Section>
    </>
  );
}

function PrivacyPage() {
  const [p, setP] = useState<PrivacySettings | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.privacy().then(setP, (e: Error) => setError(e.message));
  }, []);
  const save = (next: PrivacySettings) => {
    setP(next);
    api.setPrivacy(next).then(setP, (e: Error) => setError(e.message));
  };
  if (!p) return <h2>Gizlilik ve Güvenlik {error && <span className="error-text small">{error}</span>}</h2>;
  const fr = p.friendRequests;
  return (
    <>
      <h2>Gizlilik ve Güvenlik</h2>
      {error && <div className="error">{error}</div>}
      <Section title="Sunucu gizliliği">
        <Toggle
          label="Sunucu üyelerinden gelen özel mesajlara izin ver"
          hint="Kapalıyken yalnızca arkadaşların sana özel mesaj gönderebilir. Tüm sunucular için geçerlidir."
          checked={p.dmFromServerMembers}
          onChange={(v) => save({ ...p, dmFromServerMembers: v })}
        />
      </Section>
      <Section title="Sana kimler arkadaşlık isteği gönderebilir">
        <Toggle label="Herkes" checked={fr.everyone} onChange={(v) => save({ ...p, friendRequests: v ? { everyone: true, friendsOfFriends: true, serverMembers: true } : { ...fr, everyone: false } })} />
        <Toggle label="Arkadaşlarının arkadaşları" checked={fr.everyone || fr.friendsOfFriends} disabled={fr.everyone} onChange={(v) => save({ ...p, friendRequests: { ...fr, friendsOfFriends: v } })} />
        <Toggle label="Sunucu üyeleri" checked={fr.everyone || fr.serverMembers} disabled={fr.everyone} onChange={(v) => save({ ...p, friendRequests: { ...fr, serverMembers: v } })} />
      </Section>
      <Section title="Verilerin">
        <p className="set-hint">
          Konuşgaç'ta reklam, izleme ya da analitik yok. Verilerin yalnızca bağlandığın sunucuda durur; hesabını
          Hesabım sayfasından kalıcı olarak silebilirsin.
        </p>
      </Section>
    </>
  );
}

function describeAgent(ua: string): string {
  if (!ua) return 'Bilinmeyen cihaz';
  const app = /Electron\//.test(ua) ? 'Konuşgaç masaüstü' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Uygulama';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${app} · ${os}` : app;
}

const when = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function DevicesPage() {
  const [list, setList] = useState<Session[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api.sessions().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  return (
    <>
      <h2>Cihazlar</h2>
      <p className="set-hint">Hesabına giriş yapılmış cihazlar. Tanımadığın bir cihaz görürsen oturumunu kapat ve şifreni değiştir.</p>
      {error && <div className="error">{error}</div>}
      <div className="device-list">
        {list?.map((d) => (
          <div key={d.id} className="device">
            <div className="device-icon">{/masaüstü/.test(describeAgent(d.userAgent)) ? '🖥' : '🌐'}</div>
            <div className="grow">
              <div className="set-label">
                {describeAgent(d.userAgent)} {d.current && <span className="pill">Bu cihaz</span>}
              </div>
              <div className="set-hint">
                Son etkinlik: {when.format(d.lastUsed)} · Giriş: {when.format(d.createdAt)}
              </div>
            </div>
            {!d.current && (
              <button className="icon-btn" title="Bu cihazın oturumunu kapat" onClick={() => api.deleteSession(d.id).then(load, (e: Error) => setError(e.message))}>
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      {list && list.length > 1 && (
        <button className="danger" onClick={() => confirm('Bu cihaz dışındaki tüm oturumlar kapatılsın mı?') && api.deleteOtherSessions().then(load)}>
          Diğer tüm cihazlardan çıkış yap
        </button>
      )}
    </>
  );
}

function NotificationsPage() {
  const s = useSettings((x) => x);
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'denied' : Notification.permission);
  return (
    <>
      <h2>Bildirimler</h2>
      <Section title="Masaüstü bildirimleri">
        <Toggle
          label="Masaüstü bildirimlerini etkinleştir"
          hint="Pencere arka plandayken özel mesaj, bahsedilme ve yanıtlar için bildirim gösterir."
          checked={s.desktopNotifications}
          onChange={(v) => {
            set({ desktopNotifications: v });
            if (v && !desktop && perm === 'default') void Notification.requestPermission().then(setPerm);
          }}
        />
        {!desktop && perm === 'denied' && <p className="set-note">Tarayıcın bu site için bildirimleri engellemiş; adres çubuğundaki kilit simgesinden izin verebilirsin.</p>}
        <Toggle label="Okunmamış mesaj rozeti" hint="Görev çubuğunda ve sekme başlığında okunmamış sayısını gösterir." checked={s.unreadBadge} onChange={(v) => set({ unreadBadge: v })} />
        <Toggle label="Görev çubuğunu yanıp söndür" hint="Biri senden bahsettiğinde ya da özel mesaj geldiğinde." checked={s.flashFrame} onChange={(v) => set({ flashFrame: v })} />
      </Section>
      <Section title="Sesler">
        <Slider label="Bildirim sesi seviyesi" value={s.soundVolume} min={0} max={100} onChange={(v) => set({ soundVolume: v })} />
        {(Object.keys(SOUND_LABELS) as SoundName[]).map((name) => (
          <div key={name} className="sound-row">
            <Toggle label={SOUND_LABELS[name]} checked={s.sounds[name]} onChange={(v) => set({ sounds: { ...s.sounds, [name]: v } })} />
            <button className="icon-btn" title="Dinle" onClick={() => playSound(name, true)}>
              ▶
            </button>
          </div>
        ))}
      </Section>
    </>
  );
}

function KeybindsPage() {
  const s = useSettings((x) => x);
  return (
    <>
      <h2>Tuş Atamaları</h2>
      <p className="set-hint">Bir kısayolu değiştirmek için üstüne tıkla ve yeni tuş kombinasyonuna bas.</p>
      <div className="keybind-list">
        <div className="keybind">
          <div>
            <div className="set-label">Bas-konuş</div>
            <div className="set-hint">Basılı tuttuğun sürece mikrofonun açık olur (Ses ve Görüntü'de giriş modu bas-konuş olmalı).</div>
          </div>
          <KeyRecorder value={s.pttKey} onChange={(k) => set({ pttKey: k })} />
        </div>
        <div className="keybind">
          <div>
            <div className="set-label">Mikrofonu aç / kapat</div>
            <div className="set-hint">Masaüstü uygulamasında pencere arka plandayken de çalışır.</div>
          </div>
          <KeyRecorder value={s.toggleMuteKey} onChange={(k) => set({ toggleMuteKey: k })} />
        </div>
        <div className="keybind">
          <div>
            <div className="set-label">Sesi aç / kapat (sağırlaştır)</div>
            <div className="set-hint">Masaüstü uygulamasında pencere arka plandayken de çalışır.</div>
          </div>
          <KeyRecorder value={s.toggleDeafKey} onChange={(k) => set({ toggleDeafKey: k })} />
        </div>
      </div>
      <Section title="Sabit kısayollar">
        <div className="fixed-keys">
          <span>Mesaj gönder</span>
          <kbd>Enter</kbd>
          <span>Yeni satır</span>
          <kbd>Shift + Enter</kbd>
          <span>Yanıtı / düzenlemeyi iptal et</span>
          <kbd>Esc</kbd>
          <span>Ayarları kapat</span>
          <kbd>Esc</kbd>
        </div>
      </Section>
    </>
  );
}

function AppearancePage() {
  const s = useSettings((x) => x);
  return (
    <>
      <h2>Görünüm</h2>
      <Section title="Tema">
        <Radio<Theme>
          name="theme"
          value={s.theme}
          options={[
            ['dark', 'Koyu'],
            ['darker', 'Gece', 'Daha koyu, OLED ekranlar için.'],
            ['light', 'Açık'],
            ['system', 'Sistemle eşitle', 'İşletim sisteminin açık/koyu ayarını izler.'],
          ]}
          onChange={(v) => set({ theme: v })}
        />
      </Section>
      <Section title="Mesaj görünümü">
        <Radio
          name="density"
          value={s.compact ? 'compact' : 'cozy'}
          options={[
            ['cozy', 'Rahat', 'Modern ve ferah: profil resimleri ve gruplanmış mesajlar.'],
            ['compact', 'Kompakt', 'Ekrana daha çok mesaj sığar.'],
          ]}
          onChange={(v) => set({ compact: v === 'compact' })}
        />
      </Section>
      <Section title="Ölçeklendirme">
        <Slider label="Sohbet yazı tipi boyutu" value={s.fontSize} min={12} max={24} format={(v) => `${v} px`} onChange={(v) => set({ fontSize: v })} />
        {desktop?.setZoom && <Slider label="Yakınlaştırma düzeyi" value={s.zoom} min={50} max={200} step={10} onChange={(v) => set({ zoom: v })} />}
        <button className="link" onClick={() => resetSettings(['fontSize', 'zoom'])}>
          Varsayılana dön
        </button>
      </Section>
    </>
  );
}

function AccessibilityPage() {
  const s = useSettings((x) => x);
  return (
    <>
      <h2>Erişilebilirlik</h2>
      <Section title="Hareket">
        <Radio
          name="motion"
          value={s.reducedMotion}
          options={[
            ['system', 'Sistemle eşitle'],
            ['on', 'Hareketi azalt', 'Animasyonları ve vurgulama efektlerini kapatır.'],
            ['off', 'Hareketi azaltma'],
          ]}
          onChange={(v) => set({ reducedMotion: v })}
        />
      </Section>
      <Section title="Renk">
        <Slider label="Doygunluk" value={s.saturation} min={0} max={100} onChange={(v) => set({ saturation: v })} />
        <Toggle label="İsimlerde rol renklerini göster" checked={s.roleColors} onChange={(v) => set({ roleColors: v })} />
      </Section>
      <Section title="Metin">
        <Toggle label="Bağlantıların altını her zaman çiz" checked={s.underlineLinks} onChange={(v) => set({ underlineLinks: v })} />
      </Section>
    </>
  );
}

function TextPage() {
  const s = useSettings((x) => x);
  return (
    <>
      <h2>Metin ve Görseller</h2>
      <Section title="Medya">
        <Toggle label="Yüklenen resim ve videoları sohbette göster" hint="Kapalıyken dosya kartı olarak görünürler." checked={s.inlineMedia} onChange={(v) => set({ inlineMedia: v })} />
      </Section>
      <Section title="Tepkiler ve emojiler">
        <Toggle label="Mesajlardaki tepkileri göster" checked={s.showReactions} onChange={(v) => set({ showReactions: v })} />
        <Toggle label="İfadeleri emojiye dönüştür" hint=":) yazınca 🙂 olarak gönderilir." checked={s.convertEmoticons} onChange={(v) => set({ convertEmoticons: v })} />
      </Section>
      <Section title="Yazma">
        <Toggle label="Yazım denetimi" checked={s.spellcheck} onChange={(v) => set({ spellcheck: v })} />
        <Toggle label="Enter ile gönder" hint="Kapalıyken Ctrl + Enter ile gönderilir, Enter yeni satır açar." checked={s.sendOnEnter} onChange={(v) => set({ sendOnEnter: v })} />
      </Section>
    </>
  );
}

function WindowsPage() {
  const [w, setW] = useState<WindowSettings | null>(null);
  useEffect(() => {
    desktop?.getWindowSettings?.().then(setW, () => {});
  }, []);
  if (!w) return <h2>Windows Ayarları</h2>;
  const change = (patch: Partial<WindowSettings>) => {
    setW({ ...w, ...patch });
    desktop?.setWindowSettings?.(patch);
  };
  return (
    <>
      <h2>Windows Ayarları</h2>
      <Section title="Sistem başlangıcı">
        <Toggle label="Konuşgaç'ı aç" hint="Bilgisayar açılınca Konuşgaç da başlar." checked={w.openAtLogin} onChange={(v) => change({ openAtLogin: v })} />
        <Toggle label="Simge durumunda başlat" hint="Açılışta pencere gösterilmez; Konuşgaç sistem tepsisinde bekler." checked={w.startMinimized} disabled={!w.openAtLogin} onChange={(v) => change({ startMinimized: v })} />
      </Section>
      <Section title="Kapatma düğmesi">
        <Toggle label="Sistem tepsisine küçült" hint="Pencereyi kapatınca Konuşgaç tepside çalışmaya devam eder; tamamen kapatmak için tepsi simgesine sağ tıklayıp Çıkış'ı seç." checked={w.minimizeToTray} onChange={(v) => change({ minimizeToTray: v })} />
      </Section>
    </>
  );
}

function StreamerPage() {
  const s = useSettings((x) => x);
  return (
    <>
      <h2>Yayıncı Modu</h2>
      <Toggle
        label="Yayıncı modunu etkinleştir"
        hint="Ekranını paylaşırken ya da yayın yaparken kişisel bilgilerini gizler."
        checked={s.streamerMode}
        onChange={(v) => set({ streamerMode: v })}
      />
      <Section title="Yayıncı modu açıkken">
        <ul className="set-list">
          <li>Kullanıcı adın (@ad) ve sunucu adresi gizlenir.</li>
          <li>Davet bağlantıları gizlenir; kopyala düğmesi yine çalışır.</li>
          <li>Masaüstü bildirimleri ve bildirim sesleri kapanır.</li>
        </ul>
      </Section>
    </>
  );
}

function AdvancedPage() {
  const s = useSettings((x) => x);
  const [w, setW] = useState<WindowSettings | null>(null);
  useEffect(() => {
    desktop?.getWindowSettings?.().then(setW, () => {});
  }, []);
  return (
    <>
      <h2>Gelişmiş</h2>
      <Section title="Geliştirici">
        <Toggle
          label="Geliştirici modu"
          hint="Mesajlarda, kanallarda ve üyelerde kimliği kopyalamak için 'ID'yi kopyala' seçeneklerini gösterir."
          checked={s.developerMode}
          onChange={(v) => set({ developerMode: v })}
        />
      </Section>
      {w && (
        <Section title="Donanım">
          <Toggle
            label="Donanım hızlandırma"
            hint="Ekran kartını kullanarak arayüzü daha akıcı çizer. Değişiklik uygulamayı yeniden başlattığında geçerli olur."
            checked={w.hardwareAcceleration}
            onChange={(v) => {
              setW({ ...w, hardwareAcceleration: v });
              desktop?.setWindowSettings?.({ hardwareAcceleration: v });
            }}
          />
        </Section>
      )}
      <DesktopServer />
      <Section title="Sıfırlama">
        <button
          className="danger"
          onClick={() => {
            if (confirm('Bu cihazdaki tüm uygulama ayarları (ses, görünüm, bildirimler, tuşlar) varsayılana dönsün mü?')) {
              resetSettings(Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]);
            }
          }}
        >
          Bu cihazdaki ayarları sıfırla
        </button>
      </Section>
    </>
  );
}
