import type { PresenceStatus, User } from '@konusgac/shared';

export function Avatar({ user, size = 40, status }: { user: User | undefined; size?: number; status?: PresenceStatus }) {
  const initial = (user?.displayName || user?.username || '?').charAt(0).toLocaleUpperCase('tr');
  return (
    <span className="avatar" style={{ width: size, height: size, background: user?.avatarColor ?? '#666', fontSize: size * 0.42 }}>
      {initial}
      {status && <span className={`presence ${status}`} />}
    </span>
  );
}
