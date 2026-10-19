import { hasPerm, Perm, type Channel } from '@konusgac/shared';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { navigate } from '../actions';
import { openMenu } from '../menu';
import { channelListMenu, channelMenu, dmMenu } from '../menus';
import { channelPerms, dmPartner, getState, guildPerms, isUnread, mentionCount, useStore } from '../state';
import { openDialog } from '../ui';
import { Avatar } from './Avatar';
import { useSettings } from '../settings';
import { VoiceChannelRow, VoicePanel, VoiceToggles } from './Voice';

export function Sidebar() {
  const view = useStore((s) => s.view);
  return (
    <aside className="sidebar">
      {view.guildId === '@me' ? <DmList /> : <GuildChannels guildId={view.guildId} />}
      <VoicePanel />
      <UserPanel />
    </aside>
  );
}

function DmList() {
  const dms = useStore((s) => s.dms);
  const users = useStore((s) => s.users);
  const presences = useStore((s) => s.presences);
  const view = useStore((s) => s.view);
  useStore((s) => s.readStates);

  const sorted = useMemo(
    () => Object.values(dms).sort((a, b) => Number(BigInt(b.lastMessageId ?? b.id) - BigInt(a.lastMessageId ?? a.id))),
    [dms],
  );

  return (
    <div className="sidebar-body">
      <div className="sidebar-header">Ana Sayfa</div>
      <button className={`channel-item ${!view.channelId ? 'active' : ''}`} onClick={() => navigate('@me')}>
        <span className="channel-icon">☺</span> Arkadaşlar
      </button>
      <div className="section-title">Özel mesajlar</div>
      {sorted.length === 0 && <p className="muted small pad">Henüz özel mesajın yok.</p>}
      {sorted.map((c) => {
        const partner = dmPartner(getState(), c);
        const user = partner ? users[partner] : undefined;
        return (
          <button
            key={c.id}
            className={`channel-item dm ${view.channelId === c.id ? 'active' : ''} ${isUnread(getState(), c) ? 'unread' : ''}`}
            onClick={() => navigate('@me', c.id)}
            onContextMenu={(e) => openMenu(e, dmMenu(c, partner))}
          >
            <Avatar user={user} size={28} status={partner ? presences[partner] : undefined} />
            <span className="truncate">{user?.displayName ?? 'Bilinmeyen'}</span>
            <MentionBadge channelId={c.id} />
          </button>
        );
      })}
    </div>
  );
}

function GuildChannels({ guildId }: { guildId: string }) {
  const g = useStore((s) => s.guilds[guildId]);
  const me = useStore((s) => s.me);
  const view = useStore((s) => s.view);
  useStore((s) => s.readStates);
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (!g || !me) return <div className="sidebar-body" />;
  const s = getState();
  const perms = guildPerms(s, guildId);
  const canManageChannels = hasPerm(perms, Perm.ManageChannels);
  const isOwner = g.guild.ownerId === me.id;

  const categories = g.channels.filter((c) => c.type === 'category');
  const uncategorized = g.channels.filter((c) => c.type !== 'category' && (!c.parentId || !categories.some((k) => k.id === c.parentId)));
  const firstText = g.channels.find((c) => c.type === 'text');

  const channelActions = (c: Channel) => (
    <>
      {hasPerm(channelPerms(s, c), Perm.CreateInvite) && (
        <button className="icon-btn" title="Davet oluştur" onClick={() => openDialog({ kind: 'invite', channelId: c.id })}>
          ✉
        </button>
      )}
      {hasPerm(channelPerms(s, c), Perm.ManageChannels) && (
        <button className="icon-btn" title="Kanalı düzenle" onClick={() => openDialog({ kind: 'channelSettings', channel: c })}>
          ⚙
        </button>
      )}
    </>
  );

  const renderChannel = (c: Channel) =>
    c.type === 'voice' ? (
      <VoiceChannelRow key={c.id} channel={c} actions={channelActions(c)} />
    ) : (
      <div key={c.id} className={`channel-row ${view.channelId === c.id ? 'active' : ''} ${isUnread(s, c) ? 'unread' : ''}`}>
        <button className="channel-item" onClick={() => navigate(guildId, c.id)} onContextMenu={(e) => openMenu(e, channelMenu(c))}>
          <span className="channel-icon">#</span>
          <span className="truncate">{c.name}</span>
          <MentionBadge channelId={c.id} />
        </button>
        {channelActions(c)}
      </div>
    );

  return (
    <div className="sidebar-body">
      <button className="sidebar-header guild-header" onClick={() => setMenu(!menu)}>
        <span className="truncate">{g.guild.name}</span>
        <span>{menu ? '✕' : '▾'}</span>
      </button>
      {menu && (
        <div className="guild-menu" onClick={() => setMenu(false)}>
          {firstText && hasPerm(channelPerms(s, firstText), Perm.CreateInvite) && (
            <button onClick={() => openDialog({ kind: 'invite', channelId: firstText.id })}>İnsanları davet et</button>
          )}
          {(hasPerm(perms, Perm.ManageGuild) || hasPerm(perms, Perm.ManageRoles) || hasPerm(perms, Perm.KickMembers)) && (
            <button onClick={() => openDialog({ kind: 'guildSettings', guildId })}>Sunucu ayarları</button>
          )}
          {canManageChannels && <button onClick={() => openDialog({ kind: 'createChannel', guildId, parentId: null })}>Kanal / kategori oluştur</button>}
          {!isOwner && (
            <button
              className="danger"
              onClick={async () => {
                if (confirm(`"${g.guild.name}" sunucusundan ayrılmak istiyor musun?`)) await api.leaveGuild(guildId);
              }}
            >
              Sunucudan ayrıl
            </button>
          )}
        </div>
      )}

      <div
        className="channel-list"
        // Right-click on the empty part of the list: create a channel or category.
        onContextMenu={(e) => e.target === e.currentTarget && openMenu(e, channelListMenu(guildId))}
      >
        {uncategorized.map(renderChannel)}
        {categories.map((cat) => {
          const children = g.channels.filter((c) => c.type !== 'category' && c.parentId === cat.id);
          return (
            <div key={cat.id} className="category">
              <div
                className="category-row"
                onContextMenu={(e) =>
                  openMenu(
                    e,
                    channelMenu(cat, {
                      collapsed: !!collapsed[cat.id],
                      toggle: () => setCollapsed((cur) => ({ ...cur, [cat.id]: !cur[cat.id] })),
                      collapseAll: () => setCollapsed(Object.fromEntries(categories.map((k) => [k.id, true]))),
                    }),
                  )
                }
              >
                <button className="category-title" onClick={() => setCollapsed({ ...collapsed, [cat.id]: !collapsed[cat.id] })}>
                  {collapsed[cat.id] ? '›' : '⌄'} {cat.name}
                </button>
                {canManageChannels && (
                  <>
                    <button className="icon-btn" title="Bu kategoriye kanal ekle" onClick={() => openDialog({ kind: 'createChannel', guildId, parentId: cat.id })}>
                      +
                    </button>
                    <button className="icon-btn" title="Kategoriyi düzenle" onClick={() => openDialog({ kind: 'channelSettings', channel: cat })}>
                      ⚙
                    </button>
                  </>
                )}
              </div>
              {!collapsed[cat.id] && children.map(renderChannel)}
            </div>
          );
        })}
      </div>

    </div>
  );
}

function MentionBadge({ channelId }: { channelId: string }) {
  const n = useStore((s) => mentionCount(s, channelId));
  return n > 0 ? <span className="mention-badge">{n > 99 ? '99+' : n}</span> : null;
}

function UserPanel() {
  const me = useStore((s) => s.me);
  const streamer = useSettings((s) => s.streamerMode);
  if (!me) return null;
  return (
    <div className="user-panel">
      <Avatar user={me} size={32} status="online" />
      <div className="user-panel-names">
        <div className="truncate strong">{me.displayName}</div>
        <div className="truncate muted small">{streamer ? 'Yayıncı modu' : `@${me.username}`}</div>
      </div>
      <VoiceToggles />
      <button className="icon-btn" title="Kullanıcı ayarları" onClick={() => openDialog({ kind: 'userSettings' })}>
        ⚙
      </button>
    </div>
  );
}
