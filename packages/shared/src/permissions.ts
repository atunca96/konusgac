import type { Channel, Guild, Member, Role } from './types';

export const Perm = {
  Administrator: 1 << 0,
  ViewChannel: 1 << 1,
  SendMessages: 1 << 2,
  ReadHistory: 1 << 3,
  ManageMessages: 1 << 4,
  ManageChannels: 1 << 5,
  ManageRoles: 1 << 6,
  ManageGuild: 1 << 7,
  CreateInvite: 1 << 8,
  KickMembers: 1 << 9,
  Connect: 1 << 10,
  Speak: 1 << 11,
  AttachFiles: 1 << 12,
  AddReactions: 1 << 13,
  MentionEveryone: 1 << 14,
  Stream: 1 << 15, // camera and screen sharing in voice channels
  BanMembers: 1 << 16, // ban from the server: removed and kept from coming back
} as const;

export type PermName = keyof typeof Perm;

export const ALL_PERMISSIONS = Object.values(Perm).reduce((a, b) => a | b, 0);

export const DEFAULT_EVERYONE_PERMISSIONS =
  Perm.ViewChannel |
  Perm.SendMessages |
  Perm.ReadHistory |
  Perm.CreateInvite |
  Perm.Connect |
  Perm.Speak |
  Perm.Stream |
  Perm.AttachFiles |
  Perm.AddReactions;

export const PERMISSION_LABELS: Record<PermName, string> = {
  Administrator: 'Yönetici (her şeye izin verir)',
  ViewChannel: 'Kanalları görüntüle',
  SendMessages: 'Mesaj gönder',
  ReadHistory: 'Mesaj geçmişini oku',
  ManageMessages: 'Mesajları yönet',
  ManageChannels: 'Kanalları yönet',
  ManageRoles: 'Rolleri yönet',
  ManageGuild: 'Sunucuyu yönet',
  CreateInvite: 'Davet oluştur',
  KickMembers: 'Üyeleri at',
  Connect: 'Sesli kanala bağlan',
  Speak: 'Konuş',
  AttachFiles: 'Dosya ekle',
  AddReactions: 'Tepki ekle',
  MentionEveryone: '@everyone ile herkesi an',
  Stream: 'Kamera ve ekran paylaş',
  BanMembers: 'Üyeleri yasakla',
};

export function hasPerm(perms: number, p: number): boolean {
  return (perms & Perm.Administrator) !== 0 || (perms & p) === p;
}

// Guild-level permissions: owner gets everything; otherwise OR of @everyone and member roles.
export function computeGuildPermissions(guild: Guild, member: Member, roles: Role[]): number {
  if (guild.ownerId === member.userId) return ALL_PERMISSIONS;
  let perms = 0;
  for (const role of roles) {
    if (role.id === guild.id || member.roleIds.includes(role.id)) perms |= role.permissions;
  }
  return perms & Perm.Administrator ? ALL_PERMISSIONS : perms;
}

// Channel permissions: apply @everyone overwrite, then the union of role overwrites (deny before allow).
export function computeChannelPermissions(
  guild: Guild,
  member: Member,
  roles: Role[],
  channel: Channel,
): number {
  let perms = computeGuildPermissions(guild, member, roles);
  if (perms & Perm.Administrator) return ALL_PERMISSIONS;

  const overwrites = channel.overwrites;
  const everyone = overwrites.find((o) => o.roleId === guild.id);
  if (everyone) perms = (perms & ~everyone.deny) | everyone.allow;

  let allow = 0;
  let deny = 0;
  for (const o of overwrites) {
    if (o.roleId !== guild.id && member.roleIds.includes(o.roleId)) {
      allow |= o.allow;
      deny |= o.deny;
    }
  }
  return (perms & ~deny) | allow;
}
