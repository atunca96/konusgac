import { useState } from 'react';
import { navigate } from '../actions';
import { openMenu } from '../menu';
import { guildMenu } from '../menus';
import { DOWNLOAD_URL, useDesktopDownload } from '../download';
import { getState, isUnread, mentionCount, useStore } from '../state';
import { CreateGuildModal } from './modals/CreateGuildModal';
import { JoinInviteModal } from './modals/JoinInviteModal';

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w.charAt(0).toLocaleUpperCase('tr'))
    .join('');
}

export function ServerRail() {
  const guilds = useStore((s) => s.guilds);
  const order = useStore((s) => s.guildOrder);
  const view = useStore((s) => s.view);
  useStore((s) => s.readStates);
  const dms = useStore((s) => s.dms);
  const [modal, setModal] = useState<'create' | 'join' | null>(null);
  const offerApp = useDesktopDownload();

  const s = getState();
  const dmUnread = Object.values(dms).filter((c) => isUnread(s, c)).length;

  return (
    <nav className="rail">
      <button className={`rail-item home ${view.guildId === '@me' ? 'active' : ''}`} title="Ana sayfa" onClick={() => navigate('@me')}>
        <img src="/logo.svg" alt="Konuşgaç" />
        {dmUnread > 0 && <span className="badge">{dmUnread}</span>}
      </button>
      <div className="rail-sep" />
      {order.map((id) => {
        const g = guilds[id];
        if (!g) return null;
        const hasUnread = g.channels.some((c) => isUnread(s, c));
        const mentions = g.channels.reduce((n, c) => n + mentionCount(s, c.id), 0);
        return (
          <button
            key={id}
            className={`rail-item ${view.guildId === id ? 'active' : ''} ${hasUnread ? 'unread' : ''}`}
            title={g.guild.name}
            style={{ background: view.guildId === id ? g.guild.iconColor : undefined }}
            onClick={() => navigate(id)}
            onContextMenu={(e) => openMenu(e, guildMenu(id))}
          >
            {initials(g.guild.name)}
            {mentions > 0 && <span className="badge">{mentions > 99 ? '99+' : mentions}</span>}
          </button>
        );
      })}
      <button className="rail-item action" title="Sunucu oluştur" onClick={() => setModal('create')}>
        +
      </button>
      <button className="rail-item action" title="Davetle katıl" onClick={() => setModal('join')}>
        ⇲
      </button>
      {offerApp && (
        <a className="rail-item action" title="Windows uygulamasını indir" href={DOWNLOAD_URL}>
          ⬇
        </a>
      )}
      {modal === 'create' && <CreateGuildModal onClose={() => setModal(null)} />}
      {modal === 'join' && <JoinInviteModal onClose={() => setModal(null)} />}
    </nav>
  );
}
