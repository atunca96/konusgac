import {
  computeChannelPermissions,
  computeGuildPermissions,
  hasPerm,
  Perm,
  type Channel,
  type GuildState,
} from '@konusgac/shared';
import type { Store } from './store';

const DM_PERMISSIONS = Perm.ViewChannel | Perm.SendMessages | Perm.ReadHistory;

// Server-side authority for who may see or do what.
export class Access {
  constructor(private store: Store) {}

  guildPerms(guildId: string, userId: string): number | null {
    const guild = this.store.guild(guildId);
    const member = guild && this.store.member(guildId, userId);
    if (!guild || !member) return null;
    return computeGuildPermissions(guild, member, this.store.roles(guildId));
  }

  channelPerms(channel: Channel, userId: string): number {
    if (channel.type === 'dm') return channel.recipientIds.includes(userId) ? DM_PERMISSIONS : 0;
    const guild = this.store.guild(channel.guildId!);
    const member = guild && this.store.member(guild.id, userId);
    if (!guild || !member) return 0;
    return computeChannelPermissions(guild, member, this.store.roles(guild.id), channel);
  }

  can(channel: Channel, userId: string, perm: number): boolean {
    return hasPerm(this.channelPerms(channel, userId), perm);
  }

  // Highest role position a member holds; the owner outranks everyone.
  rank(guildId: string, userId: string): number {
    const guild = this.store.guild(guildId);
    if (!guild) return -1;
    if (guild.ownerId === userId) return Number.MAX_SAFE_INTEGER;
    const member = this.store.member(guildId, userId);
    if (!member) return -1;
    const roles = this.store.roles(guildId).filter((r) => member.roleIds.includes(r.id));
    return Math.max(0, ...roles.map((r) => r.position));
  }

  // Users who can view the channel.
  viewers(channel: Channel): string[] {
    if (channel.type === 'dm') return channel.recipientIds;
    const state = this.store.guildState(channel.guildId!);
    if (!state) return [];
    return state.members
      .filter((m) => hasPerm(computeChannelPermissions(state.guild, m, state.roles, channel), Perm.ViewChannel))
      .map((m) => m.userId);
  }

  // A member's view of a guild: channels they cannot see are removed, and a
  // category is kept only if it is itself visible or holds a visible channel.
  filterGuildState(state: GuildState, userId: string): GuildState {
    const member = state.members.find((m) => m.userId === userId);
    if (!member) return { ...state, channels: [] };
    const visible = new Set(
      state.channels
        .filter((c) => hasPerm(computeChannelPermissions(state.guild, member, state.roles, c), Perm.ViewChannel))
        .map((c) => c.id),
    );
    const channels = state.channels.filter(
      (c) => visible.has(c.id) || (c.type === 'category' && state.channels.some((x) => x.parentId === c.id && visible.has(x.id))),
    );
    return { ...state, channels };
  }
}
