import {
  DEFAULT_EVERYONE_PERMISSIONS,
  searchText,
  type Attachment,
  type Channel,
  type ChannelType,
  type Guild,
  type GuildState,
  type Invite,
  type Member,
  type Message,
  type PermissionOverwrite,
  type PrivacySettings,
  type Reaction,
  type ReadState,
  type Session,
  type Relationship,
  type RelationshipType,
  type Role,
  type User,
  type GuildBan,
  type PlatformBan,
  type Report,
  type ReportReason,
} from '@konusgac/shared';
import { randomBytes } from 'node:crypto';
import { hashToken, newToken } from './auth';
import { transaction, type Db } from './db';
import { snowflake } from './snowflake';

type Row = Record<string, string | number | null>;

const PALETTE = ['#e8590c', '#2b8a3e', '#1971c2', '#c2255c', '#6741d9', '#0c8599', '#e67700', '#5c940d'];

export function colorFor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export interface Account {
  email: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  google: boolean; // signs in with Google
  siteAdmin: boolean; // runs this server: sees reports, removes content, bans accounts
}

export type OneTimeKind = 'verifyEmail' | 'resetPassword' | 'login';

const toUser = (r: Row): User => ({
  id: r.id as string,
  username: r.username as string,
  displayName: r.display_name as string,
  avatarColor: r.avatar_color as string,
});

const toGuild = (r: Row): Guild => ({
  id: r.id as string,
  name: r.name as string,
  ownerId: r.owner_id as string,
  iconColor: r.icon_color as string,
});

const toRole = (r: Row): Role => ({
  id: r.id as string,
  guildId: r.guild_id as string,
  name: r.name as string,
  color: r.color as string,
  permissions: r.permissions as number,
  position: r.position as number,
});

export interface NewAttachment {
  fileKey: string;
  filename: string;
  size: number;
  contentType: string;
}

const toInvite = (r: Row): Invite => ({
  code: r.code as string,
  guildId: r.guild_id as string,
  channelId: r.channel_id as string,
  creatorId: r.creator_id as string,
  uses: r.uses as number,
  maxUses: r.max_uses as number,
  expiresAt: (r.expires_at as number | null) ?? null,
});

export class Store {
  constructor(readonly db: Db) {}

  private get<T = Row>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T = Row>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).run(...params);
  }

  // ---------- users & sessions ----------

  createUser(input: {
    username: string;
    displayName: string;
    passwordHash: string;
    hasPassword?: boolean; // false: made with Google, no password chosen yet
    email?: string | null;
    emailVerified?: boolean;
    googleSub?: string | null;
  }): User {
    const id = snowflake();
    this.run(
      `INSERT INTO users (id, username, display_name, password_hash, avatar_color, created_at, has_password, email, email_verified, google_sub, terms_accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.username, input.displayName, input.passwordHash, colorFor(input.username), Date.now(),
      input.hasPassword === false ? 0 : 1, input.email ?? null, input.emailVerified ? 1 : 0, input.googleSub ?? null,
      Date.now(), // every way in (sign-up form, Google) shows the terms first
    );
    return this.user(id)!;
  }

  // ---------- e-mail and Google ----------

  // Private account details, only ever sent to the account's owner.
  account(userId: string): Account {
    const r = this.get('SELECT email, email_verified, has_password, google_sub FROM users WHERE id = ?', userId)!;
    return {
      email: (r.email as string | null) ?? null,
      emailVerified: r.email_verified === 1,
      hasPassword: r.has_password === 1,
      google: r.google_sub !== null,
      siteAdmin: false, // filled in by the route, which knows the operators
    };
  }

  userIdByEmail(email: string): string | undefined {
    return this.get<{ id: string }>('SELECT id FROM users WHERE email = ?', email.toLowerCase())?.id;
  }

  userIdByGoogle(sub: string): string | undefined {
    return this.get<{ id: string }>('SELECT id FROM users WHERE google_sub = ?', sub)?.id;
  }

  setEmail(userId: string, email: string | null, verified: boolean) {
    this.run('UPDATE users SET email = ?, email_verified = ? WHERE id = ?', email?.toLowerCase() ?? null, verified ? 1 : 0, userId);
  }

  linkGoogle(userId: string, sub: string) {
    this.run('UPDATE users SET google_sub = ? WHERE id = ?', sub, userId);
  }

  // A single-use token (e-mail link or sign-in code); only its hash is stored.
  createOneTimeToken(kind: OneTimeKind, userId: string, ttlMs: number, email: string | null = null): string {
    const { token, hash } = newToken();
    const now = Date.now();
    this.run('DELETE FROM one_time_tokens WHERE expires_at < ?', now);
    // A new link of the same kind replaces older ones, so only the latest mail works.
    this.run('DELETE FROM one_time_tokens WHERE user_id = ? AND kind = ?', userId, kind);
    this.run('INSERT INTO one_time_tokens (token_hash, user_id, kind, email, expires_at) VALUES (?, ?, ?, ?, ?)', hash, userId, kind, email, now + ttlMs);
    return token;
  }

  // Uses up a token: it works once, and not after it expired.
  consumeOneTimeToken(kind: OneTimeKind, token: string): { userId: string; email: string | null } | undefined {
    const hash = hashToken(token);
    const r = this.get('SELECT user_id, email, expires_at FROM one_time_tokens WHERE token_hash = ? AND kind = ?', hash, kind);
    if (!r) return undefined;
    this.run('DELETE FROM one_time_tokens WHERE token_hash = ?', hash);
    if ((r.expires_at as number) < Date.now()) return undefined;
    return { userId: r.user_id as string, email: (r.email as string | null) ?? null };
  }

  // ---------- moderation ----------

  // Platform ban: the account cannot sign in any more; every device is signed out.
  banUser(userId: string, reason: string) {
    transaction(this.db, () => {
      this.run('UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?', Date.now(), reason, userId);
      this.run('DELETE FROM sessions WHERE user_id = ?', userId);
    });
  }

  unbanUser(userId: string) {
    this.run("UPDATE users SET banned_at = NULL, ban_reason = '' WHERE id = ?", userId);
  }

  isBanned(userId: string): boolean {
    return this.get<{ banned_at: number | null }>('SELECT banned_at FROM users WHERE id = ?', userId)?.banned_at != null;
  }

  platformBans(): PlatformBan[] {
    return this.all('SELECT * FROM users WHERE banned_at IS NOT NULL ORDER BY banned_at DESC').map((r) => ({
      user: toUser(r),
      reason: r.ban_reason as string,
      bannedAt: r.banned_at as number,
    }));
  }

  banFromGuild(guildId: string, userId: string, reason: string, by: string) {
    this.run(
      'INSERT OR REPLACE INTO guild_bans (guild_id, user_id, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?)',
      guildId, userId, reason, by, Date.now(),
    );
  }

  unbanFromGuild(guildId: string, userId: string): boolean {
    return Number(this.db.prepare('DELETE FROM guild_bans WHERE guild_id = ? AND user_id = ?').run(guildId, userId).changes) > 0;
  }

  isBannedFromGuild(guildId: string, userId: string): boolean {
    return !!this.get('SELECT 1 FROM guild_bans WHERE guild_id = ? AND user_id = ?', guildId, userId);
  }

  guildBans(guildId: string): GuildBan[] {
    return this.all(
      'SELECT u.*, b.reason AS ban_reason_g, b.created_at AS banned_g FROM guild_bans b JOIN users u ON u.id = b.user_id WHERE b.guild_id = ? ORDER BY b.created_at DESC',
      guildId,
    ).map((r) => ({ user: toUser(r), reason: r.ban_reason_g as string, createdAt: r.banned_g as number }));
  }

  createReport(input: {
    reporterId: string;
    message: Message;
    guildId: string | null;
    reason: ReportReason;
    note: string;
  }): string {
    const id = snowflake();
    this.run(
      `INSERT INTO reports (id, reporter_id, message_id, channel_id, guild_id, author_id, reason, note, content, attachments, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.reporterId, input.message.id, input.message.channelId, input.guildId, input.message.authorId,
      input.reason, input.note, input.message.content, JSON.stringify(input.message.attachments.map((a) => a.filename)), Date.now(),
    );
    return id;
  }

  reports(status: 'open' | 'resolved'): Report[] {
    return this.all('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT 200', status).map((r) => {
      const channel = this.channel(r.channel_id as string);
      const guild = r.guild_id ? this.guild(r.guild_id as string) : undefined;
      return {
        id: r.id as string,
        reason: r.reason as ReportReason,
        note: r.note as string,
        status: r.status as 'open' | 'resolved',
        createdAt: r.created_at as number,
        reporter: r.reporter_id ? (this.user(r.reporter_id as string) ?? null) : null,
        author: r.author_id ? (this.user(r.author_id as string) ?? null) : null,
        messageId: (r.message_id as string | null) ?? null,
        messageExists: !!(r.message_id && this.message(r.message_id as string)),
        channelId: r.channel_id as string,
        guildId: (r.guild_id as string | null) ?? null,
        guildName: guild?.name ?? null,
        channelName: channel?.name ?? null,
        content: r.content as string,
        attachments: JSON.parse(r.attachments as string) as string[],
      };
    });
  }

  resolveReport(id: string, by: string): boolean {
    return Number(this.db.prepare("UPDATE reports SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'").run(by, Date.now(), id).changes) > 0;
  }

  // A user's messages from the last ms milliseconds (to clean up after a spammer).
  recentMessageIds(userId: string, ms: number): { id: string; channelId: string }[] {
    const since = Date.now() - ms;
    return this.all<{ id: string; channel_id: string }>('SELECT id, channel_id FROM messages WHERE author_id = ? AND created_at >= ?', userId, since).map((r) => ({
      id: r.id,
      channelId: r.channel_id,
    }));
  }

  // Password reset from an e-mail link: the new password, and every device signed out.
  resetPassword(userId: string, passwordHash: string) {
    transaction(this.db, () => {
      this.run('UPDATE users SET password_hash = ?, has_password = 1 WHERE id = ?', passwordHash, userId);
      this.run('DELETE FROM sessions WHERE user_id = ?', userId);
    });
  }

  user(id: string): User | undefined {
    const r = this.get('SELECT * FROM users WHERE id = ?', id);
    return r && toUser(r);
  }

  userByUsername(username: string): User | undefined {
    const r = this.get('SELECT * FROM users WHERE username = ?', username);
    return r && toUser(r);
  }

  // Sign-in by user name or e-mail address.
  passwordHash(login: string): { userId: string; hash: string } | undefined {
    const r = login.includes('@')
      ? this.get('SELECT id, password_hash FROM users WHERE email = ?', login.toLowerCase())
      : this.get('SELECT id, password_hash FROM users WHERE username = ?', login);
    return r && { userId: r.id as string, hash: r.password_hash as string };
  }

  updateUser(id: string, patch: { displayName?: string; avatarColor?: string }): User {
    if (patch.displayName !== undefined) this.run('UPDATE users SET display_name = ? WHERE id = ?', patch.displayName, id);
    if (patch.avatarColor !== undefined) this.run('UPDATE users SET avatar_color = ? WHERE id = ?', patch.avatarColor, id);
    return this.user(id)!;
  }

  users(ids: Iterable<string>): User[] {
    const list = [...new Set(ids)];
    if (list.length === 0) return [];
    return this.all(`SELECT * FROM users WHERE id IN (${list.map(() => '?').join(',')})`, ...list).map(toUser);
  }

  createSession(userId: string, tokenHash: string, userAgent = '') {
    const now = Date.now();
    this.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, user_agent, last_used) VALUES (?, ?, ?, ?, ?)',
      tokenHash, userId, now, userAgent.slice(0, 300), now,
    );
  }

  sessionUserId(tokenHash: string): string | undefined {
    const r = this.get<{ user_id: string; last_used: number }>('SELECT user_id, last_used FROM sessions WHERE token_hash = ?', tokenHash);
    if (!r) return undefined;
    // "Last active" for the devices list, written at most once a minute.
    if (Date.now() - r.last_used > 60_000) this.run('UPDATE sessions SET last_used = ? WHERE token_hash = ?', Date.now(), tokenHash);
    return r.user_id;
  }

  // A session's public id is a prefix of its token hash: enough to name it, useless to sign in.
  sessions(userId: string, currentHash: string): Session[] {
    return this.all('SELECT token_hash, user_agent, created_at, last_used FROM sessions WHERE user_id = ? ORDER BY last_used DESC', userId).map(
      (r) => ({
        id: (r.token_hash as string).slice(0, 16),
        userAgent: r.user_agent as string,
        createdAt: r.created_at as number,
        lastUsed: r.last_used as number,
        current: r.token_hash === currentHash,
      }),
    );
  }

  deleteSessionById(userId: string, id: string): boolean {
    return Number(this.run("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?", userId, id).changes) > 0;
  }

  deleteOtherSessions(userId: string, keepHash: string) {
    this.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, keepHash);
  }

  privacy(userId: string): PrivacySettings {
    const r = this.get('SELECT dm_from_members, friend_requests FROM users WHERE id = ?', userId)!;
    return { dmFromServerMembers: r.dm_from_members === 1, friendRequests: JSON.parse(r.friend_requests as string) };
  }

  setPrivacy(userId: string, p: PrivacySettings): PrivacySettings {
    this.run('UPDATE users SET dm_from_members = ?, friend_requests = ? WHERE id = ?', p.dmFromServerMembers ? 1 : 0, JSON.stringify(p.friendRequests), userId);
    return this.privacy(userId);
  }

  sharesGuild(a: string, b: string): boolean {
    return !!this.get('SELECT 1 FROM members m1 JOIN members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 1', a, b);
  }

  hasMutualFriend(a: string, b: string): boolean {
    return !!this.get(
      `SELECT 1 FROM relationships r1 JOIN relationships r2 ON r1.other_id = r2.other_id
       WHERE r1.user_id = ? AND r2.user_id = ? AND r1.type = 'friend' AND r2.type = 'friend' LIMIT 1`,
      a, b,
    );
  }

  deleteSession(tokenHash: string) {
    this.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }

  passwordHashById(userId: string): string | undefined {
    return this.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', userId)?.password_hash;
  }

  // Sets a new password and signs out every other session.
  setPassword(userId: string, passwordHash: string, keepTokenHash: string) {
    transaction(this.db, () => {
      this.run('UPDATE users SET password_hash = ?, has_password = 1 WHERE id = ?', passwordHash, userId);
      this.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, keepTokenHash);
    });
  }

  ownedGuildIds(userId: string): string[] {
    return this.all<{ id: string }>('SELECT id FROM guilds WHERE owner_id = ?', userId).map((r) => r.id);
  }

  // Erases a user's personal data (KVKK): the account can no longer sign in, leaves every
  // server, loses friends, reactions and read marks, and its name becomes "Silinmiş kullanıcı".
  // Messages stay so conversations remain readable, shown under the anonymous name.
  deleteAccount(userId: string): { guildIds: string[]; relatedIds: string[] } {
    const guildIds = this.guildIdsForUser(userId);
    const relatedIds = this.relationships(userId).map((r) => r.userId);
    transaction(this.db, () => {
      this.run('DELETE FROM sessions WHERE user_id = ?', userId);
      this.run('DELETE FROM members WHERE user_id = ?', userId);
      this.run('DELETE FROM relationships WHERE user_id = ? OR other_id = ?', userId, userId);
      this.run('DELETE FROM reactions WHERE user_id = ?', userId);
      this.run('DELETE FROM read_states WHERE user_id = ?', userId);
      this.run('DELETE FROM one_time_tokens WHERE user_id = ?', userId);
      this.run(
        "UPDATE users SET username = ?, display_name = 'Silinmiş kullanıcı', password_hash = '!', avatar_color = '#747f8d', email = NULL, email_verified = 0, google_sub = NULL WHERE id = ?",
        `silinmis_${userId}`, userId,
      );
    });
    return { guildIds, relatedIds };
  }

  // ---------- guilds ----------

  createGuild(ownerId: string, name: string): GuildState {
    const guildId = snowflake();
    transaction(this.db, () => {
      this.run(
        'INSERT INTO guilds (id, name, owner_id, icon_color, created_at) VALUES (?, ?, ?, ?, ?)',
        guildId, name, ownerId, colorFor(name + guildId), Date.now(),
      );
      // @everyone shares the guild's ID
      this.run(
        'INSERT INTO roles (id, guild_id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?, 0)',
        guildId, guildId, '@everyone', '#99aab5', DEFAULT_EVERYONE_PERMISSIONS,
      );
      const category = this.insertChannel({ guildId, type: 'category', name: 'Metin Kanalları', parentId: null, topic: '' });
      this.insertChannel({ guildId, type: 'text', name: 'genel', parentId: category, topic: '' });
      const voice = this.insertChannel({ guildId, type: 'category', name: 'Ses Kanalları', parentId: null, topic: '' });
      this.insertChannel({ guildId, type: 'voice', name: 'Genel', parentId: voice, topic: '' });
      this.run('INSERT INTO members (guild_id, user_id, nick, joined_at) VALUES (?, ?, NULL, ?)', guildId, ownerId, Date.now());
    });
    return this.guildState(guildId)!;
  }

  guild(id: string): Guild | undefined {
    const r = this.get('SELECT * FROM guilds WHERE id = ?', id);
    return r && toGuild(r);
  }

  updateGuild(id: string, patch: { name?: string; ownerId?: string }): Guild {
    if (patch.name !== undefined) this.run('UPDATE guilds SET name = ? WHERE id = ?', patch.name, id);
    if (patch.ownerId !== undefined) this.run('UPDATE guilds SET owner_id = ? WHERE id = ?', patch.ownerId, id);
    return this.guild(id)!;
  }

  deleteGuild(id: string) {
    this.run('DELETE FROM guilds WHERE id = ?', id);
  }

  guildIdsForUser(userId: string): string[] {
    return this.all<{ guild_id: string }>('SELECT guild_id FROM members WHERE user_id = ?', userId).map((r) => r.guild_id);
  }

  guildState(id: string): GuildState | undefined {
    const guild = this.guild(id);
    if (!guild) return undefined;
    return { guild, channels: this.guildChannels(id), roles: this.roles(id), members: this.members(id) };
  }

  memberCount(guildId: string): number {
    return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM members WHERE guild_id = ?', guildId)!.n;
  }

  // ---------- roles ----------

  roles(guildId: string): Role[] {
    return this.all('SELECT * FROM roles WHERE guild_id = ? ORDER BY position', guildId).map(toRole);
  }

  role(id: string): Role | undefined {
    const r = this.get('SELECT * FROM roles WHERE id = ?', id);
    return r && toRole(r);
  }

  createRole(guildId: string, input: { name: string; color: string; permissions: number }): Role {
    const id = snowflake();
    const pos = this.get<{ p: number }>('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM roles WHERE guild_id = ?', guildId)!.p;
    this.run(
      'INSERT INTO roles (id, guild_id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?, ?)',
      id, guildId, input.name, input.color, input.permissions, pos,
    );
    return this.role(id)!;
  }

  updateRole(id: string, patch: { name?: string; color?: string; permissions?: number }): Role {
    if (patch.name !== undefined) this.run('UPDATE roles SET name = ? WHERE id = ?', patch.name, id);
    if (patch.color !== undefined) this.run('UPDATE roles SET color = ? WHERE id = ?', patch.color, id);
    if (patch.permissions !== undefined) this.run('UPDATE roles SET permissions = ? WHERE id = ?', patch.permissions, id);
    return this.role(id)!;
  }

  deleteRole(id: string) {
    transaction(this.db, () => {
      this.run('DELETE FROM roles WHERE id = ?', id);
      // drop overwrites that referenced the role
      for (const r of this.all('SELECT id, overwrites FROM channels WHERE overwrites LIKE ?', `%${id}%`)) {
        const ows = (JSON.parse(r.overwrites as string) as PermissionOverwrite[]).filter((o) => o.roleId !== id);
        this.run('UPDATE channels SET overwrites = ? WHERE id = ?', JSON.stringify(ows), r.id as string);
      }
    });
  }

  // ---------- members ----------

  member(guildId: string, userId: string): Member | undefined {
    const r = this.get('SELECT * FROM members WHERE guild_id = ? AND user_id = ?', guildId, userId);
    if (!r) return undefined;
    const roleIds = this.all<{ role_id: string }>(
      'SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?', guildId, userId,
    ).map((x) => x.role_id);
    return { guildId, userId, nick: (r.nick as string | null) ?? null, roleIds, joinedAt: r.joined_at as number };
  }

  members(guildId: string): Member[] {
    const roleMap = new Map<string, string[]>();
    for (const r of this.all<{ user_id: string; role_id: string }>(
      'SELECT user_id, role_id FROM member_roles WHERE guild_id = ?', guildId,
    )) {
      const list = roleMap.get(r.user_id) ?? [];
      list.push(r.role_id);
      roleMap.set(r.user_id, list);
    }
    return this.all('SELECT * FROM members WHERE guild_id = ? ORDER BY joined_at', guildId).map((r) => ({
      guildId,
      userId: r.user_id as string,
      nick: (r.nick as string | null) ?? null,
      roleIds: roleMap.get(r.user_id as string) ?? [],
      joinedAt: r.joined_at as number,
    }));
  }

  memberUserIds(guildId: string): string[] {
    return this.all<{ user_id: string }>('SELECT user_id FROM members WHERE guild_id = ?', guildId).map((r) => r.user_id);
  }

  addMember(guildId: string, userId: string): Member {
    this.run('INSERT OR IGNORE INTO members (guild_id, user_id, nick, joined_at) VALUES (?, ?, NULL, ?)', guildId, userId, Date.now());
    return this.member(guildId, userId)!;
  }

  removeMember(guildId: string, userId: string) {
    this.run('DELETE FROM members WHERE guild_id = ? AND user_id = ?', guildId, userId);
  }

  updateMember(guildId: string, userId: string, patch: { nick?: string | null; roleIds?: string[] }): Member {
    transaction(this.db, () => {
      if (patch.nick !== undefined) {
        this.run('UPDATE members SET nick = ? WHERE guild_id = ? AND user_id = ?', patch.nick, guildId, userId);
      }
      if (patch.roleIds !== undefined) {
        this.run('DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?', guildId, userId);
        for (const roleId of new Set(patch.roleIds)) {
          this.run('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)', guildId, userId, roleId);
        }
      }
    });
    return this.member(guildId, userId)!;
  }

  // ---------- channels ----------

  private toChannel(r: Row): Channel {
    const type = r.type as ChannelType;
    return {
      id: r.id as string,
      guildId: (r.guild_id as string | null) ?? null,
      type,
      name: r.name as string,
      parentId: (r.parent_id as string | null) ?? null,
      position: r.position as number,
      topic: r.topic as string,
      overwrites: JSON.parse(r.overwrites as string) as PermissionOverwrite[],
      recipientIds:
        type === 'dm'
          ? this.all<{ user_id: string }>('SELECT user_id FROM dm_recipients WHERE channel_id = ?', r.id as string).map((x) => x.user_id)
          : [],
      lastMessageId: (r.last_message_id as string | null) ?? null,
    };
  }

  private insertChannel(input: { guildId: string | null; type: ChannelType; name: string; parentId: string | null; topic: string }): string {
    const id = snowflake();
    const pos = input.guildId
      ? this.get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE guild_id = ?', input.guildId)!.p
      : 0;
    this.run(
      'INSERT INTO channels (id, guild_id, type, name, parent_id, position, topic) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, input.guildId, input.type, input.name, input.parentId, pos, input.topic,
    );
    return id;
  }

  channel(id: string): Channel | undefined {
    const r = this.get('SELECT * FROM channels WHERE id = ?', id);
    return r && this.toChannel(r);
  }

  guildChannels(guildId: string): Channel[] {
    return this.all('SELECT * FROM channels WHERE guild_id = ? ORDER BY position', guildId).map((r) => this.toChannel(r));
  }

  createChannel(input: { guildId: string; type: 'text' | 'voice' | 'category'; name: string; parentId: string | null; topic: string }): Channel {
    return this.channel(this.insertChannel(input))!;
  }

  updateChannel(
    id: string,
    patch: { name?: string; topic?: string; parentId?: string | null; position?: number; overwrites?: PermissionOverwrite[] },
  ): Channel {
    if (patch.name !== undefined) this.run('UPDATE channels SET name = ? WHERE id = ?', patch.name, id);
    if (patch.topic !== undefined) this.run('UPDATE channels SET topic = ? WHERE id = ?', patch.topic, id);
    if (patch.parentId !== undefined) this.run('UPDATE channels SET parent_id = ? WHERE id = ?', patch.parentId, id);
    if (patch.position !== undefined) this.run('UPDATE channels SET position = ? WHERE id = ?', patch.position, id);
    if (patch.overwrites !== undefined) this.run('UPDATE channels SET overwrites = ? WHERE id = ?', JSON.stringify(patch.overwrites), id);
    return this.channel(id)!;
  }

  // Returns channels whose parent was cleared as a side effect.
  deleteChannel(id: string): Channel[] {
    return transaction(this.db, () => {
      const children = this.all<{ id: string }>('SELECT id FROM channels WHERE parent_id = ?', id).map((r) => r.id);
      this.run('UPDATE channels SET parent_id = NULL WHERE parent_id = ?', id);
      this.run('DELETE FROM channels WHERE id = ?', id);
      return children.map((c) => this.channel(c)!);
    });
  }

  dmChannels(userId: string): Channel[] {
    return this.all(
      `SELECT c.* FROM channels c JOIN dm_recipients r ON r.channel_id = c.id
       WHERE r.user_id = ? ORDER BY CAST(COALESCE(c.last_message_id, c.id) AS INTEGER) DESC`,
      userId,
    ).map((r) => this.toChannel(r));
  }

  openDm(a: string, b: string): { channel: Channel; created: boolean } {
    const existing = this.get<{ channel_id: string }>(
      `SELECT r1.channel_id FROM dm_recipients r1 JOIN dm_recipients r2 ON r1.channel_id = r2.channel_id
       WHERE r1.user_id = ? AND r2.user_id = ?`,
      a, b,
    );
    if (existing) return { channel: this.channel(existing.channel_id)!, created: false };
    const id = transaction(this.db, () => {
      const cid = this.insertChannel({ guildId: null, type: 'dm', name: '', parentId: null, topic: '' });
      this.run('INSERT INTO dm_recipients (channel_id, user_id) VALUES (?, ?)', cid, a);
      this.run('INSERT INTO dm_recipients (channel_id, user_id) VALUES (?, ?)', cid, b);
      return cid;
    });
    return { channel: this.channel(id)!, created: true };
  }

  // ---------- messages ----------

  createMessage(input: {
    channelId: string;
    authorId: string;
    content: string;
    replyToId: string | null;
    mentionIds: string[];
    mentionEveryone: boolean;
    attachments: NewAttachment[];
  }): Message {
    const id = snowflake();
    transaction(this.db, () => {
      this.run(
        `INSERT INTO messages (id, channel_id, author_id, content, created_at, reply_to_id, mention_ids, mention_everyone, search_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.channelId, input.authorId, input.content, Date.now(), input.replyToId,
        JSON.stringify(input.mentionIds), input.mentionEveryone ? 1 : 0, searchText(input.content),
      );
      input.attachments.forEach((a, i) =>
        this.run(
          'INSERT INTO attachments (id, message_id, file_key, filename, size, content_type, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
          snowflake(), id, a.fileKey, a.filename, a.size, a.contentType, i,
        ),
      );
      this.run('UPDATE channels SET last_message_id = ? WHERE id = ?', id, input.channelId);
    });
    return this.message(id)!;
  }

  message(id: string): Message | undefined {
    const r = this.get('SELECT * FROM messages WHERE id = ?', id);
    return r && this.hydrate([r])[0];
  }

  // Newest-last page of messages strictly older than `before`.
  messages(channelId: string, before: string | null, limit: number): Message[] {
    const rows = before
      ? this.all(
          'SELECT * FROM messages WHERE channel_id = ? AND CAST(id AS INTEGER) < CAST(? AS INTEGER) ORDER BY CAST(id AS INTEGER) DESC LIMIT ?',
          channelId, before, limit,
        )
      : this.all('SELECT * FROM messages WHERE channel_id = ? ORDER BY CAST(id AS INTEGER) DESC LIMIT ?', channelId, limit);
    return this.hydrate(rows).reverse();
  }

  updateMessage(id: string, patch: { content: string; mentionIds: string[]; mentionEveryone: boolean }): Message {
    this.run(
      'UPDATE messages SET content = ?, mention_ids = ?, mention_everyone = ?, search_text = ?, edited_at = ? WHERE id = ?',
      patch.content, JSON.stringify(patch.mentionIds), patch.mentionEveryone ? 1 : 0, searchText(patch.content), Date.now(), id,
    );
    return this.message(id)!;
  }

  // Returns the file keys of the message's attachments so their files can be removed.
  deleteMessage(id: string): string[] {
    const keys = this.fileKeys('SELECT file_key FROM attachments WHERE message_id = ?', id);
    this.run('DELETE FROM messages WHERE id = ?', id);
    return keys;
  }

  fileKeys(sql: string, ...params: string[]): string[] {
    return this.all<{ file_key: string }>(sql, ...params).map((r) => r.file_key);
  }

  allFileKeys(): Set<string> {
    return new Set(this.fileKeys('SELECT file_key FROM attachments'));
  }

  // Messages in the given channels whose text contains every word of the query, newest first.
  search(channelIds: string[], query: string, before: string | null, limit: number): Message[] {
    if (channelIds.length === 0) return [];
    const words = searchText(query).split(/\s+/).filter(Boolean).slice(0, 8);
    if (words.length === 0) return [];
    const like = words.map(() => "search_text LIKE ? ESCAPE '\\'").join(' AND ');
    const params = [
      ...channelIds,
      ...words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
      ...(before ? [before] : []),
    ];
    const rows = this.all(
      `SELECT * FROM messages WHERE channel_id IN (${channelIds.map(() => '?').join(',')}) AND ${like}
       ${before ? 'AND CAST(id AS INTEGER) < CAST(? AS INTEGER)' : ''}
       ORDER BY CAST(id AS INTEGER) DESC LIMIT ?`,
      ...params, limit,
    );
    return this.hydrate(rows);
  }

  // Adds attachments, reactions and the replied-to snapshot to message rows, in bulk.
  private hydrate(rows: Row[]): Message[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id as string);
    const marks = ids.map(() => '?').join(',');
    const attachments = new Map<string, Attachment[]>();
    for (const a of this.all(`SELECT * FROM attachments WHERE message_id IN (${marks}) ORDER BY position`, ...ids)) {
      const list = attachments.get(a.message_id as string) ?? [];
      list.push({
        id: a.id as string,
        filename: a.filename as string,
        size: a.size as number,
        contentType: a.content_type as string,
        url: `/attachments/${a.file_key as string}/${encodeURIComponent(a.filename as string)}`,
      });
      attachments.set(a.message_id as string, list);
    }
    const reactions = new Map<string, Reaction[]>();
    for (const r of this.all(`SELECT * FROM reactions WHERE message_id IN (${marks}) ORDER BY created_at`, ...ids)) {
      const list = reactions.get(r.message_id as string) ?? [];
      const emoji = r.emoji as string;
      let entry = list.find((x) => x.emoji === emoji);
      if (!entry) list.push((entry = { emoji, userIds: [] }));
      entry.userIds.push(r.user_id as string);
      reactions.set(r.message_id as string, list);
    }
    const replyIds = [...new Set(rows.map((r) => r.reply_to_id as string | null).filter((x): x is string => !!x))];
    const replies = new Map<string, Row>();
    if (replyIds.length) {
      for (const r of this.all(
        `SELECT id, author_id, content FROM messages WHERE id IN (${replyIds.map(() => '?').join(',')})`, ...replyIds,
      )) {
        replies.set(r.id as string, r);
      }
    }
    return rows.map((r) => {
      const replyId = r.reply_to_id as string | null;
      const ref = replyId ? replies.get(replyId) : undefined;
      return {
        id: r.id as string,
        channelId: r.channel_id as string,
        authorId: r.author_id as string,
        content: r.content as string,
        createdAt: r.created_at as number,
        editedAt: (r.edited_at as number | null) ?? null,
        replyTo: replyId
          ? { id: replyId, authorId: (ref?.author_id as string | undefined) ?? null, content: ref ? (ref.content as string).slice(0, 200) : null }
          : null,
        mentionIds: JSON.parse(r.mention_ids as string) as string[],
        mentionEveryone: r.mention_everyone === 1,
        attachments: attachments.get(r.id as string) ?? [],
        reactions: reactions.get(r.id as string) ?? [],
      };
    });
  }

  // ---------- reactions ----------

  reactionEmojiCount(messageId: string): number {
    return this.get<{ n: number }>('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?', messageId)!.n;
  }

  hasReaction(messageId: string, emoji: string): boolean {
    return !!this.get('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ? LIMIT 1', messageId, emoji);
  }

  // True if the reaction was new.
  addReaction(messageId: string, userId: string, emoji: string): boolean {
    return (
      Number(
        this.run(
          'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
          messageId, userId, emoji, Date.now(),
        ).changes,
      ) > 0
    );
  }

  removeReaction(messageId: string, userId: string, emoji: string): boolean {
    return Number(this.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, emoji).changes) > 0;
  }

  // ---------- read states ----------

  readStates(userId: string): ReadState[] {
    return this.all('SELECT * FROM read_states WHERE user_id = ?', userId).map((r) => ({
      channelId: r.channel_id as string,
      lastReadId: (r.last_read_id as string | null) ?? null,
      mentionCount: r.mention_count as number,
    }));
  }

  ack(userId: string, channelId: string, messageId: string): ReadState {
    this.run(
      `INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, ?, 0)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET mention_count = 0,
         last_read_id = CASE WHEN last_read_id IS NULL OR CAST(excluded.last_read_id AS INTEGER) > CAST(last_read_id AS INTEGER)
                             THEN excluded.last_read_id ELSE last_read_id END`,
      userId, channelId, messageId,
    );
    return this.readStates(userId).find((r) => r.channelId === channelId)!;
  }

  // Puts the read mark exactly at messageId, also backwards.
  setReadMark(userId: string, channelId: string, messageId: string): ReadState {
    this.run(
      `INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, ?, 0)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id`,
      userId, channelId, messageId,
    );
    return this.readStates(userId).find((r) => r.channelId === channelId)!;
  }

  addMentions(channelId: string, userIds: Iterable<string>) {
    for (const userId of new Set(userIds)) {
      this.run(
        `INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, NULL, 1)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET mention_count = mention_count + 1`,
        userId, channelId,
      );
    }
  }

  // ---------- relationships ----------

  relationships(userId: string): Relationship[] {
    return this.all<{ other_id: string; type: RelationshipType }>(
      'SELECT other_id, type FROM relationships WHERE user_id = ?', userId,
    ).map((r) => ({ userId: r.other_id, type: r.type }));
  }

  relationship(userId: string, otherId: string): RelationshipType | undefined {
    return this.get<{ type: RelationshipType }>(
      'SELECT type FROM relationships WHERE user_id = ? AND other_id = ?', userId, otherId,
    )?.type;
  }

  setRelationship(userId: string, otherId: string, type: RelationshipType) {
    this.run(
      'INSERT INTO relationships (user_id, other_id, type) VALUES (?, ?, ?) ON CONFLICT(user_id, other_id) DO UPDATE SET type = excluded.type',
      userId, otherId, type,
    );
  }

  deleteRelationshipPair(a: string, b: string) {
    this.run('DELETE FROM relationships WHERE (user_id = ? AND other_id = ?) OR (user_id = ? AND other_id = ?)', a, b, b, a);
  }

  // ---------- invites ----------

  createInvite(guildId: string, channelId: string, creatorId: string, maxUses: number, expiresAt: number | null): Invite {
    const code = randomBytes(6).toString('base64url');
    this.run(
      'INSERT INTO invites (code, guild_id, channel_id, creator_id, uses, max_uses, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      code, guildId, channelId, creatorId, maxUses, expiresAt,
    );
    return this.invite(code)!;
  }

  invite(code: string): Invite | undefined {
    const r = this.get('SELECT * FROM invites WHERE code = ?', code);
    return r && toInvite(r);
  }

  useInvite(code: string) {
    this.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', code);
  }

  // ---------- visibility ----------

  // Users whose profile/presence this user should know about.
  relatedUserIds(userId: string): Set<string> {
    const ids = new Set<string>([userId]);
    for (const r of this.all<{ user_id: string }>(
      `SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = ?
       UNION SELECT r2.user_id FROM dm_recipients r1 JOIN dm_recipients r2 ON r1.channel_id = r2.channel_id WHERE r1.user_id = ?
       UNION SELECT other_id FROM relationships WHERE user_id = ?`,
      userId, userId, userId,
    )) {
      ids.add(r.user_id);
    }
    return ids;
  }
}
