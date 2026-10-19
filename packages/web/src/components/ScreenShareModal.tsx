import { useEffect, useState } from 'react';
import { desktop, type ScreenSource } from '../notify';
import { updateSettings, useSettings, type Settings } from '../settings';
import { startScreenShare } from '../voice';
import { Modal } from './modals/Modal';

// "Ekranını paylaş": in the desktop app our own picker of screens and windows; in a browser
// the browser asks which screen after this. Quality choices are kept for next time.
export function ScreenShareModal({ onClose }: { onClose: () => void }) {
  const resolution = useSettings((s) => s.streamResolution);
  const fps = useSettings((s) => s.streamFps);
  const audio = useSettings((s) => s.streamAudio);
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [tab, setTab] = useState<'window' | 'screen'>('screen');
  const [picked, setPicked] = useState<string | null>(null);
  const native = !!desktop?.screenSources;
  const windows = /Windows/.test(navigator.userAgent);

  useEffect(() => {
    if (!desktop?.screenSources) return;
    void desktop.screenSources().then((list) => {
      setSources(list);
      setPicked(list.find((s) => s.screen)?.id ?? list[0]?.id ?? null);
    });
  }, []);

  const shown = sources?.filter((s) => s.screen === (tab === 'screen')) ?? [];
  const start = () => {
    void startScreenShare({ sourceId: picked ?? undefined, resolution, fps, audio });
    onClose();
  };

  return (
    <Modal title="Ekranını paylaş" onClose={onClose} wide>
      {native && (
        <>
          <div className="segmented">
            <button className={tab === 'screen' ? 'active' : ''} onClick={() => setTab('screen')}>
              Ekranlar
            </button>
            <button className={tab === 'window' ? 'active' : ''} onClick={() => setTab('window')}>
              Uygulamalar
            </button>
          </div>
          <div className="source-grid">
            {sources === null && <div className="muted small">Ekranlar ve pencereler aranıyor…</div>}
            {sources !== null && shown.length === 0 && <div className="muted small">Paylaşılabilecek bir şey bulunamadı.</div>}
            {shown.map((s) => (
              <button key={s.id} className={`source ${picked === s.id ? 'active' : ''}`} onClick={() => setPicked(s.id)} onDoubleClick={start}>
                <img src={s.thumbnail} alt="" />
                <span className="truncate small">{s.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {!native && <p className="muted small">Hangi ekranı, pencereyi ya da sekmeyi paylaşacağını bir sonraki adımda tarayıcın soracak.</p>}

      <div className="stream-quality">
        <Choice<Settings['streamResolution']>
          label="Çözünürlük"
          value={resolution}
          options={[[720, '720p'], [1080, '1080p'], [0, 'Kaynak']]}
          onChange={(v) => updateSettings({ streamResolution: v })}
        />
        <Choice<Settings['streamFps']>
          label="Kare hızı"
          value={fps}
          options={[[15, '15 FPS'], [30, '30 FPS'], [60, '60 FPS']]}
          onChange={(v) => updateSettings({ streamFps: v })}
        />
      </div>
      {(windows || !native) && (
        <label className="context-check">
          <input type="checkbox" checked={audio} onChange={(e) => updateSettings({ streamAudio: e.target.checked })} />
          {native ? 'Bilgisayarın sesini de paylaş' : 'Sesi de paylaş (tarayıcı destekliyorsa)'}
        </label>
      )}
      <p className="muted small">Yüksek çözünürlük ve kare hızı, izleyenlerin bağlantısı yavaşsa takılmaya yol açabilir.</p>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose}>Vazgeç</button>
        <button className="primary" disabled={native && !picked} onClick={start}>
          Yayına başla
        </button>
      </div>
    </Modal>
  );
}

function Choice<T extends number>(props: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="choice">
      <div className="choice-label">{props.label}</div>
      <div className="segmented">
        {props.options.map(([v, text]) => (
          <button key={v} className={props.value === v ? 'active' : ''} onClick={() => props.onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
