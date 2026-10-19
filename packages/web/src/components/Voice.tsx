import { hasPerm, Perm, type Channel } from '@konusgac/shared';
import { useState, type ReactNode } from 'react';
import { useSettings } from '../settings';
import { navigate } from '../actions';
import { openMenu } from '../menu';
import { channelMenu, userMenu } from '../menus';
import { dismissVoiceError, joinVoice, leaveVoice, screenShareSupported, stopScreenShare, toggleCamera, toggleDeaf, toggleMute } from '../voice';
import { channelById, channelPerms, displayName, getState, myVoiceHere, useStore, voiceMembers } from '../state';
import { Avatar } from './Avatar';
import { CameraIcon, HangUpIcon, HeadphonesIcon, MicIcon, ScreenIcon, SpeakerIcon } from './icons';
import { ScreenShareModal } from './ScreenShareModal';

// A voice channel in the sidebar: clicking joins it; connected users are listed below.
export function VoiceChannelRow({ channel, actions }: { channel: Channel; actions: ReactNode }) {
  const members = useStore((s) => s.voice);
  const users = useStore((s) => s.users);
  const speaking = useStore((s) => s.speaking);
  const rtcState = useStore((s) => s.rtcState);
  const self = useStore((s) => s.voiceSelf);
  const meId = useStore((s) => s.me?.id);
  const s = getState();
  const canConnect = hasPerm(channelPerms(s, channel), Perm.Connect);
  const inHere = self.channelId === channel.id;
  const userMutes = useSettings((x) => x.userMutes);
  const list = voiceMembers({ ...s, voice: members }, channel.id).sort((a, b) =>
    displayName(s, a.userId, channel.guildId ?? undefined).localeCompare(displayName(s, b.userId, channel.guildId ?? undefined), 'tr'),
  );

  return (
    <div className="voice-channel">
      <div className={`channel-row ${inHere ? 'active' : ''}`}>
        <button
          className="channel-item"
          disabled={!canConnect}
          title={canConnect ? 'Sesli kanala katıl' : 'Bu kanala bağlanma iznin yok'}
          onClick={() => {
            void joinVoice(channel.id);
            if (channel.guildId) navigate(channel.guildId, channel.id);
          }}
          onContextMenu={(e) => openMenu(e, channelMenu(channel))}
        >
          <span className="channel-icon">
            <SpeakerIcon size={17} />
          </span>
          <span className="truncate">{channel.name}</span>
        </button>
        {actions}
      </div>
      {list.length > 0 && (
        <div className="voice-members">
          {list.map((v) => {
            const linking = inHere && v.userId !== meId && rtcState !== 'connected';
            return (
              <div
                key={v.userId}
                className="voice-member"
                data-user={v.userId}
                onContextMenu={(e) => openMenu(e, userMenu(v.userId, { guildId: channel.guildId ?? undefined, voice: inHere }))}
              >
                <span className={`speak-ring ${speaking[v.userId] ? 'speaking' : ''}`}>
                  <Avatar user={users[v.userId]} size={24} />
                </span>
                <span className={`truncate ${linking ? 'muted' : ''}`} title={linking ? 'Ses bağlantısı kuruluyor…' : undefined}>
                  {displayName(s, v.userId, channel.guildId ?? undefined)}
                </span>
                <span className="voice-flags">
                  {v.selfStream && <span className="live-pill">CANLI</span>}
                  {v.selfVideo && (
                    <span title="Kamerası açık">
                      <CameraIcon size={14} />
                    </span>
                  )}
                  {(v.selfMute || v.suppress) && (
                    <span title={v.suppress ? 'Konuşma izni yok' : 'Mikrofonu kapalı'}>
                      <MicIcon size={14} off />
                    </span>
                  )}
                  {v.selfDeaf && (
                    <span title="Sesi kapalı">
                      <HeadphonesIcon size={14} off />
                    </span>
                  )}
                  {userMutes[v.userId] && (
                    <span title="Senin için susturuldu">
                      <SpeakerIcon size={14} />
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Connection status above the user panel while this tab is in (or joining) a voice channel.
export function VoicePanel() {
  const self = useStore((s) => s.voiceSelf);
  const here = useStore(myVoiceHere);
  const channel = useStore((s) => channelById(s, self.channelId));
  const guildName = useStore((s) => (channel?.guildId ? s.guilds[channel.guildId]?.guild.name : undefined));
  const canStream = useStore((s) => (channel ? hasPerm(channelPerms(s, channel), Perm.Stream) : false));
  const [picker, setPicker] = useState(false);

  if (!self.channelId) {
    if (!self.error) return null;
    return (
      <div className="voice-panel">
        <div className="grow error-text small">{self.error}</div>
        <button className="icon-btn" title="Kapat" onClick={dismissVoiceError}>
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="voice-panel">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className={`small strong ${self.connecting ? 'muted' : 'success-text'}`}>
          {self.connecting ? 'Bağlanıyor…' : 'Ses bağlantısı kuruldu'}
        </div>
        <div className="truncate small muted">
          {channel?.name ?? 'Sesli kanal'}
          {guildName ? ` / ${guildName}` : ''}
        </div>
        {self.noMic && <div className="small muted">Mikrofon yok: yalnızca dinliyorsun</div>}
        {self.silent && <div className="small warn-text">Mikrofonundan ses gelmiyor. Ayarlar → Ses ve Görüntü'den cihazını kontrol et.</div>}
        {here?.suppress && <div className="small muted">Bu kanalda konuşma iznin yok</div>}
        {self.error && <div className="small error-text">{self.error}</div>}
      </div>
      <button className="icon-btn hangup" title="Bağlantıyı kes" onClick={leaveVoice}>
        <HangUpIcon />
      </button>
      {!self.connecting && (
        <div className="voice-media">
          <button
            className={self.selfVideo ? 'on' : ''}
            disabled={!canStream}
            title={canStream ? undefined : 'Bu kanalda görüntü paylaşma iznin yok'}
            onClick={() => void toggleCamera()}
          >
            <CameraIcon size={16} /> {self.selfVideo ? 'Kamerayı kapat' : 'Kamera'}
          </button>
          <button
            className={self.selfStream ? 'on' : ''}
            disabled={!canStream || !screenShareSupported()}
            title={canStream ? undefined : 'Bu kanalda yayın izni yok'}
            onClick={() => (self.selfStream ? stopScreenShare() : setPicker(true))}
          >
            <ScreenIcon size={16} /> {self.selfStream ? 'Yayını durdur' : 'Ekran'}
          </button>
        </div>
      )}
      {picker && <ScreenShareModal onClose={() => setPicker(false)} />}
    </div>
  );
}

// Mic and headphone toggles in the user panel; they apply now and to future joins.
export function VoiceToggles() {
  const self = useStore((s) => s.voiceSelf);
  return (
    <>
      <button
        className={`icon-btn ${self.selfMute || self.selfDeaf ? 'off' : ''}`}
        title={self.selfMute ? 'Mikrofonu aç' : 'Mikrofonu kapat'}
        aria-pressed={self.selfMute}
        onClick={toggleMute}
      >
        <MicIcon off={self.selfMute || self.selfDeaf || self.noMic} />
      </button>
      <button
        className={`icon-btn ${self.selfDeaf ? 'off' : ''}`}
        title={self.selfDeaf ? 'Sesi aç' : 'Sesi kapat (sağırlaştır)'}
        aria-pressed={self.selfDeaf}
        onClick={toggleDeaf}
      >
        <HeadphonesIcon off={self.selfDeaf} />
      </button>
    </>
  );
}
