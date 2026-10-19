import { hasPerm, Perm, type Channel, type VoiceState } from '@konusgac/shared';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSettings } from '../settings';
import { channelPerms, displayName, getState, useStore, voiceMembers } from '../state';
import {
  getMediaVersion,
  isWatching,
  joinVoice,
  leaveVoice,
  mediaStream,
  screenShareSupported,
  setStreamQuality,
  stopScreenShare,
  subscribeMedia,
  toggleCamera,
  toggleDeaf,
  toggleMute,
  watchStream,
} from '../voice';
import { openMenu } from '../menu';
import { userMenu } from '../menus';
import { Avatar } from './Avatar';
import { CameraIcon, HangUpIcon, HeadphonesIcon, MicIcon, ScreenIcon, SpeakerIcon } from './icons';
import { ScreenShareModal } from './ScreenShareModal';

// The main area while a voice channel is open: one tile per person (their camera, or their
// avatar), one more tile per screen share, and the call controls. Clicking a tile puts it in
// focus; a double click (or the button) shows it full screen.

interface Tile {
  key: string;
  userId: string;
  kind: 'camera' | 'screen' | 'avatar';
}

function tilesOf(members: VoiceState[]): Tile[] {
  const screens: Tile[] = [];
  const people: Tile[] = [];
  for (const v of members) {
    if (v.selfStream) screens.push({ key: `${v.userId}:screen`, userId: v.userId, kind: 'screen' });
    people.push({ key: `${v.userId}:camera`, userId: v.userId, kind: v.selfVideo ? 'camera' : 'avatar' });
  }
  return [...screens, ...people];
}

export function CallView({ channel }: { channel: Channel }) {
  const voice = useStore((s) => s.voice);
  const self = useStore((s) => s.voiceSelf);
  const [focus, setFocus] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  useSyncExternalStore(subscribeMedia, getMediaVersion);

  const s = getState();
  const guildId = channel.guildId ?? undefined;
  const members = voiceMembers({ ...s, voice }, channel.id).sort((a, b) =>
    displayName(s, a.userId, guildId).localeCompare(displayName(s, b.userId, guildId), 'tr'),
  );
  const tiles = tilesOf(members);
  const inHere = self.channelId === channel.id;
  const perms = channelPerms(s, channel);
  const canStream = hasPerm(perms, Perm.Stream);
  const focused = tiles.find((t) => t.key === focus);
  const rest = focused ? tiles.filter((t) => t !== focused) : tiles;

  return (
    <div className="call-view">
      <header className="chat-header">
        <span className="channel-icon">
          <SpeakerIcon size={18} />
        </span>
        <strong>{channel.name}</strong>
      </header>
      <div className="call-stage">
        {tiles.length === 0 && <div className="call-empty muted">Kanalda kimse yok.</div>}
        {focused && (
          <div className="call-focus">
            <CallTile tile={focused} guildId={guildId} inHere={inHere} big onClick={() => setFocus(null)} />
          </div>
        )}
        <div className={focused ? 'call-strip' : `call-grid n${Math.min(rest.length, 9)}`}>
          {rest.map((t) => (
            <CallTile key={t.key} tile={t} guildId={guildId} inHere={inHere} big={!focused && rest.length <= 2} onClick={() => setFocus(t.key)} />
          ))}
        </div>
      </div>
      <div className="call-controls">
        {inHere ? (
          <>
            <button
              className={`call-btn ${self.selfVideo ? 'on' : ''}`}
              disabled={!canStream}
              title={canStream ? (self.selfVideo ? 'Kamerayı kapat' : 'Kamerayı aç') : 'Bu kanalda görüntü paylaşma iznin yok'}
              onClick={() => void toggleCamera()}
            >
              <CameraIcon size={22} off={!self.selfVideo} />
            </button>
            <button
              className={`call-btn ${self.selfStream ? 'on' : ''}`}
              disabled={!canStream || !screenShareSupported()}
              title={
                !canStream ? 'Bu kanalda yayın izni yok' : self.selfStream ? 'Yayını durdur' : 'Ekranını paylaş'
              }
              onClick={() => (self.selfStream ? stopScreenShare() : setPicker(true))}
            >
              <ScreenIcon size={22} />
            </button>
            <button className={`call-btn ${self.selfMute ? 'off' : ''}`} title={self.selfMute ? 'Mikrofonu aç' : 'Mikrofonu kapat'} onClick={toggleMute}>
              <MicIcon size={22} off={self.selfMute || self.selfDeaf || self.noMic} />
            </button>
            <button className={`call-btn ${self.selfDeaf ? 'off' : ''}`} title={self.selfDeaf ? 'Sesi aç' : 'Sesi kapat (sağırlaştır)'} onClick={toggleDeaf}>
              <HeadphonesIcon size={22} off={self.selfDeaf} />
            </button>
            <button className="call-btn hangup" title="Bağlantıyı kes" onClick={leaveVoice}>
              <HangUpIcon size={22} />
            </button>
          </>
        ) : (
          <button
            className="primary"
            disabled={!hasPerm(perms, Perm.Connect)}
            onClick={() => void joinVoice(channel.id)}
          >
            Sesli kanala katıl
          </button>
        )}
      </div>
      {picker && <ScreenShareModal onClose={() => setPicker(false)} />}
    </div>
  );
}

function CallTile(props: { tile: Tile; guildId?: string; inHere: boolean; big?: boolean; onClick: () => void }) {
  const { tile, guildId, inHere, big, onClick } = props;
  const user = useStore((s) => s.users[tile.userId]);
  const speaking = useStore((s) => !!s.speaking[tile.userId]);
  const state = useStore((s) => s.voice[tile.userId]);
  const meId = useStore((s) => s.me?.id);
  const muted = useSettings((x) => !!x.userMutes[tile.userId]);
  const ref = useRef<HTMLDivElement>(null);
  const stream = tile.kind === 'avatar' ? null : mediaStream(tile.userId, tile.kind);
  const name = displayName(getState(), tile.userId, guildId);
  const fullscreen = () => void ref.current?.requestFullscreen?.().catch(() => {});
  const watching = tile.kind === 'screen' && isWatching(tile.userId);
  const own = tile.userId === meId;
  // Big tiles get the sharp layer of the stream, small ones a lighter layer.
  const kind = tile.kind === 'avatar' ? null : tile.kind;
  useEffect(() => {
    if (kind && stream) setStreamQuality(tile.userId, kind, !!big);
  }, [kind, stream, big, tile.userId]);

  return (
    <div
      ref={ref}
      className={`call-tile ${big ? 'big' : ''} ${speaking && tile.kind !== 'screen' ? 'speaking' : ''}`}
      onClick={onClick}
      onDoubleClick={fullscreen}
      onContextMenu={(e) => openMenu(e, userMenu(tile.userId, { guildId, voice: inHere }))}
    >
      {stream ? (
        <Video stream={stream} mirror={tile.kind === 'camera' && tile.userId === meId} contain={tile.kind === 'screen'} />
      ) : (
        <div className="call-avatar">
          <Avatar user={user} size={big ? 112 : 72} />
          {tile.kind === 'screen' &&
            (!inHere ? (
              <div className="small muted">Yayını izlemek için kanala katıl</div>
            ) : watching ? (
              <div className="small muted">Yayın yükleniyor…</div>
            ) : (
              <button
                className="primary"
                onClick={(e) => {
                  e.stopPropagation();
                  watchStream(tile.userId, true);
                }}
              >
                Yayını izle
              </button>
            ))}
        </div>
      )}
      <div className="tile-label">
        {tile.kind === 'screen' && <span className="live-pill">CANLI</span>}
        <span className="truncate">{tile.kind === 'screen' ? `${name} ekranını paylaşıyor` : name}</span>
        {tile.kind !== 'screen' && (state?.selfMute || state?.suppress) && <MicIcon size={14} off />}
        {tile.kind !== 'screen' && state?.selfDeaf && <HeadphonesIcon size={14} off />}
        {muted && <SpeakerIcon size={14} />}
      </div>
      {stream && tile.kind === 'screen' && !own && (
        <button
          className="tile-stop-watch"
          title="Yayını bırak"
          onClick={(e) => {
            e.stopPropagation();
            watchStream(tile.userId, false);
          }}
        >
          Yayını bırak
        </button>
      )}
      {stream && (
        <button
          className="tile-fullscreen"
          title="Tam ekran"
          onClick={(e) => {
            e.stopPropagation();
            fullscreen();
          }}
        >
          ⛶
        </button>
      )}
    </div>
  );
}

function Video({ stream, mirror, contain }: { stream: MediaStream; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    void v.play().catch(() => {});
    return () => {
      v.srcObject = null;
    };
  }, [stream]);
  // Sound is played by the voice engine (with each person's volume), so the element stays muted.
  return <video ref={ref} className={`${mirror ? 'mirror' : ''} ${contain ? 'contain' : ''}`} autoPlay playsInline muted />;
}
