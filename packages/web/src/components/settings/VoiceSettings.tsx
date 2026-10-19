import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, PROFILES, updateSettings, useSettings, type InputProfile } from '../../settings';
import { useStore } from '../../state';
import { currentThreshold, listDevices, startCameraPreview, startMicTest, voiceInputLevel, type Devices } from '../../voice';
import { KeyRecorder, LevelMeter, Radio, Section, Select, Slider, Toggle } from './controls';

const deviceName = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`;

export function VoiceSettings() {
  const s = useSettings((x) => x);
  const [devices, setDevices] = useState<Devices | null>(null);

  const refresh = () => void listDevices().then(setDevices, () => setDevices(null));
  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, []);

  // A filter changed by hand means the profile is now "custom".
  const setFilter = (patch: Partial<typeof s>) => updateSettings({ ...patch, inputProfile: 'custom' });

  const inputs: [string, string][] = [['default', 'Varsayılan'], ...(devices?.inputs ?? []).map((d, i): [string, string] => [d.deviceId, deviceName(d, i, 'Mikrofon')])];
  const outputs: [string, string][] = [['default', 'Varsayılan'], ...(devices?.outputs ?? []).map((d, i): [string, string] => [d.deviceId, deviceName(d, i, 'Hoparlör')])];

  return (
    <>
      <h2>Ses ve Görüntü</h2>

      <Section title="Ses ayarları">
        <div className="set-grid">
          <Select label="Giriş cihazı" value={s.inputDeviceId} options={inputs} onChange={(v) => updateSettings({ inputDeviceId: v })} />
          <Select
            label="Çıkış cihazı"
            value={s.outputDeviceId}
            options={outputs}
            disabled={devices ? !devices.outputSelectable : false}
            onChange={(v) => updateSettings({ outputDeviceId: v })}
          />
          <Slider label="Giriş ses seviyesi" value={s.inputVolume} min={0} max={200} onChange={(v) => updateSettings({ inputVolume: v })} />
          <Slider label="Çıkış ses seviyesi" value={s.outputVolume} min={0} max={200} onChange={(v) => updateSettings({ outputVolume: v })} />
        </div>
        {devices && devices.inputs.every((d) => !d.label) && (
          <p className="set-note">Cihaz adlarını görmek için aşağıdaki mikrofon testini bir kez başlat; tarayıcı mikrofon izni ister.</p>
        )}
        <MicTest onPermission={refresh} />
      </Section>

      <Section title="Giriş modu">
        <Radio
          name="input-mode"
          value={s.inputMode}
          options={[
            ['voice', 'Ses etkinliği', 'Konuşmaya başlayınca mikrofon kendiliğinden açılır.'],
            ['ptt', 'Bas-konuş', 'Mikrofon yalnızca atadığın tuşa basılıyken açık olur.'],
          ]}
          onChange={(v) => updateSettings({ inputMode: v })}
        />
        {s.inputMode === 'ptt' ? (
          <div className="set-grid">
            <div className="set-select">
              <span className="set-label">Kısayol</span>
              <KeyRecorder value={s.pttKey} onChange={(k) => updateSettings({ pttKey: k })} />
            </div>
            <Slider
              label="Bas-konuş bırakma gecikmesi"
              value={s.pttReleaseDelay}
              min={0}
              max={2000}
              step={10}
              format={(v) => `${v} ms`}
              onChange={(v) => updateSettings({ pttReleaseDelay: v })}
            />
          </div>
        ) : (
          <Sensitivity />
        )}
        {s.inputMode === 'ptt' && (
          <p className="set-note">
            Bas-konuş tuşu Konuşgaç penceresi öndeyken çalışır. Masaüstü uygulamasında mikrofonu ve sesi açıp kapatma
            kısayolları ise her yerden çalışır (Tuş Atamaları).
          </p>
        )}
      </Section>

      <Section title="Giriş profili" note="Bir filtreyi elle değiştirdiğinde profil Özel'e geçer.">
        <Radio<InputProfile>
          name="input-profile"
          value={s.inputProfile}
          options={[
            ['isolation', 'Ses yalıtımı', 'Yalnızca senin sesin: gürültü ve yankı bastırılır, hassasiyet otomatik.'],
            ['studio', 'Stüdyo', 'İşlenmemiş ses: müzik ve iyi bir mikrofon için tüm filtreler kapalı.'],
            ['custom', 'Özel', 'Filtreleri aşağıdan kendin seç.'],
          ]}
          onChange={(v) => updateSettings(v === 'custom' ? { inputProfile: v } : { ...PROFILES[v], inputProfile: v })}
        />
      </Section>

      <Section title="Ses işleme">
        <Toggle label="Yankı engelleme" hint="Hoparlörden gelen sesin mikrofona geri dönmesini önler." checked={s.echoCancellation} onChange={(v) => setFilter({ echoCancellation: v })} />
        <Toggle label="Gürültü bastırma" hint="Klavye, fan ve uğultu gibi sabit arka plan seslerini azaltır." checked={s.noiseSuppression} onChange={(v) => setFilter({ noiseSuppression: v })} />
        <Toggle label="Otomatik kazanç kontrolü" hint="Sesini sabit bir seviyede tutar; çok kısık ya da çok yüksek konuşmayı dengeler." checked={s.automaticGainControl} onChange={(v) => setFilter({ automaticGainControl: v })} />
      </Section>

      <Section title="Gelişmiş">
        <Toggle
          label="Sessizlik uyarısı"
          hint="Sesli kanaldayken mikrofonundan hiç ses gelmiyorsa uyarı gösterir."
          checked={s.silenceWarning}
          onChange={(v) => updateSettings({ silenceWarning: v })}
        />
        <button
          className="link"
          onClick={() =>
            updateSettings({
              inputDeviceId: DEFAULT_SETTINGS.inputDeviceId,
              outputDeviceId: DEFAULT_SETTINGS.outputDeviceId,
              inputVolume: DEFAULT_SETTINGS.inputVolume,
              outputVolume: DEFAULT_SETTINGS.outputVolume,
              inputMode: DEFAULT_SETTINGS.inputMode,
              ...PROFILES.isolation,
              inputProfile: 'isolation',
              userVolumes: {},
              userMutes: {},
            })
          }
        >
          Ses ayarlarını sıfırla
        </button>
      </Section>

      <CameraSection devices={devices} onPermission={refresh} />
    </>
  );
}

// "Haydi kontrol edelim": hear yourself and watch the level.
function MicTest({ onPermission }: { onPermission: () => void }) {
  const [running, setRunning] = useState(false);
  const [db, setDb] = useState(-100);
  const [error, setError] = useState('');
  const stop = useRef<(() => void) | null>(null);
  const settingsKey = useSettings((x) => JSON.stringify([x.inputDeviceId, x.outputDeviceId, x.inputVolume, x.outputVolume, x.echoCancellation, x.noiseSuppression, x.automaticGainControl]));

  async function start() {
    setError('');
    try {
      stop.current = await startMicTest(setDb, true);
      setRunning(true);
      onPermission();
    } catch (err) {
      setError(`Mikrofon açılamadı: ${(err as Error).message}`);
    }
  }
  function end() {
    stop.current?.();
    stop.current = null;
    setRunning(false);
    setDb(-100);
  }
  // Restart with new settings, stop when the page closes.
  useEffect(() => {
    if (running) {
      stop.current?.();
      void start();
    }
  }, [settingsKey]);
  useEffect(() => () => stop.current?.(), []);

  return (
    <div className="mic-test">
      <div className="set-label">Mikrofon testi</div>
      <p className="set-hint">Testi başlatıp konuş: sesin sana geri çalınır, böylece başkalarının seni nasıl duyduğunu duyarsın.</p>
      <div className="row">
        <button className={running ? 'danger' : 'primary'} onClick={() => (running ? end() : void start())}>
          {running ? 'Testi durdur' : 'Haydi kontrol edelim'}
        </button>
        <LevelMeter db={running ? db : -100} />
      </div>
      {error && <div className="error-text small">{error}</div>}
    </div>
  );
}

// Voice activity sensitivity, with the live level when in a call.
function Sensitivity() {
  // one value per hook: a selector must return something stable, not a new object
  const s = { auto: useSettings((x) => x.autoThreshold), threshold: useSettings((x) => x.threshold) };
  const inCall = useStore((st) => !!st.voiceSelf.channelId);
  const [db, setDb] = useState(-100);
  const [thr, setThr] = useState(currentThreshold());

  useEffect(() => {
    const t = setInterval(() => {
      setDb(voiceInputLevel() ?? -100);
      setThr(currentThreshold());
    }, 50);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="stack">
      <Toggle
        label="Giriş hassasiyetini otomatik belirle"
        hint="Konuşgaç ortamının gürültüsünü ölçer ve sesinin ne zaman gönderileceğine kendisi karar verir."
        checked={s.auto}
        onChange={(v) => updateSettings({ autoThreshold: v, inputProfile: 'custom' })}
      />
      {!s.auto && (
        <Slider
          label="Giriş hassasiyeti"
          value={s.threshold}
          min={-100}
          max={0}
          format={(v) => `${v} dB`}
          onChange={(v) => updateSettings({ threshold: v, inputProfile: 'custom' })}
        />
      )}
      {inCall ? (
        <LevelMeter db={db} threshold={thr} />
      ) : (
        <p className="set-hint">Sesli bir kanaldayken burada canlı seviyeni ve eşiği görürsün; çubuk yeşilse sesin gönderiliyor.</p>
      )}
    </div>
  );
}

function CameraSection({ devices, onPermission }: { devices: Devices | null; onPermission: () => void }) {
  const videoDeviceId = useSettings((x) => x.videoDeviceId);
  const [on, setOn] = useState(false);
  const [error, setError] = useState('');
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!on || !video.current) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    startCameraPreview(video.current, videoDeviceId).then(
      (s) => {
        if (cancelled) s();
        else {
          stop = s;
          onPermission();
        }
      },
      (err: Error) => {
        setError(`Kamera açılamadı: ${err.message}`);
        setOn(false);
      },
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [on, videoDeviceId]);

  const cameras: [string, string][] = [['default', 'Varsayılan'], ...(devices?.cameras ?? []).map((d, i): [string, string] => [d.deviceId, deviceName(d, i, 'Kamera')])];
  return (
    <Section title="Görüntü ayarları" note="Görüntülü sohbet ve ekran paylaşımı yol haritasında; seçtiğin kamera o zaman kullanılacak.">
      <div className="camera-preview">
        {on ? <video ref={video} muted playsInline /> : <div className="camera-off">Kamera kapalı</div>}
      </div>
      <div className="row">
        <button className={on ? 'danger' : 'primary'} onClick={() => (setError(''), setOn(!on))}>
          {on ? 'Kamerayı kapat' : 'Kamerayı test et'}
        </button>
        <Select label="Kamera" value={videoDeviceId} options={cameras} onChange={(v) => updateSettings({ videoDeviceId: v })} />
      </div>
      {error && <div className="error-text small">{error}</div>}
    </Section>
  );
}
