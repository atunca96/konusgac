import { useMemo } from 'react';
import { openDmWith } from '../actions';
import { openMenu } from '../menu';
import { userMenu } from '../menus';
import { useSettings } from '../settings';
import { displayName, getState, roleColor, useStore } from '../state';
import { Avatar } from './Avatar';

export function MemberList({ guildId }: { guildId: string }) {
  const g = useStore((s) => s.guilds[guildId]);
  const users = useStore((s) => s.users);
  const presences = useStore((s) => s.presences);
  const me = useStore((s) => s.me);
  const roleColors = useSettings((x) => x.roleColors);

  const groups = useMemo(() => {
    if (!g) return [];
    const s = getState();
    const sorted = [...g.members].sort((a, b) => displayName(s, a.userId, guildId).localeCompare(displayName(s, b.userId, guildId), 'tr'));
    const online = sorted.filter((m) => presences[m.userId] === 'online');
    const offline = sorted.filter((m) => presences[m.userId] !== 'online');
    return [
      { title: `Çevrimiçi — ${online.length}`, members: online },
      { title: `Çevrimdışı — ${offline.length}`, members: offline },
    ];
  }, [g, users, presences, guildId]);

  if (!g) return null;
  const s = getState();

  return (
    <aside className="members">
      {groups.map((group) =>
        group.members.length === 0 ? null : (
          <div key={group.title}>
            <div className="section-title">{group.title}</div>
            {group.members.map((m) => {
              const status = presences[m.userId] ?? 'offline';
              const isOwner = g.guild.ownerId === m.userId;
              return (
                <button
                  key={m.userId}
                  className={`member ${status}`}
                  title={m.userId === me?.id ? 'Sen' : 'Özel mesaj gönder'}
                  onClick={() => m.userId !== me?.id && void openDmWith(m.userId).catch((e) => alert((e as Error).message))}
                  onContextMenu={(e) => openMenu(e, userMenu(m.userId, { guildId }))}
                >
                  <Avatar user={users[m.userId]} size={32} status={status} />
                  <span className="truncate" style={{ color: roleColors ? roleColor(s, guildId, m.userId) : undefined }}>
                    {displayName(s, m.userId, guildId)}
                  </span>
                  {isOwner && (
                    <span className="crown" title="Sunucu sahibi">
                      ♛
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ),
      )}
    </aside>
  );
}
