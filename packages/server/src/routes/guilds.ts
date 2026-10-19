import { ALL_PERMISSIONS, LIMITS, Perm, hasPerm } from '@konusgac/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { channelName, color, forbidden, HttpError, id, notFound, requireAuth, type Ctx } from '../http';

const guildName = z.string().trim().min(1, 'boş olamaz').max(LIMITS.guildNameMax);
const permissions = z.number().int().min(0).max(ALL_PERMISSIONS);

const createRole = z.object({
  name: z.string().trim().min(1).max(LIMITS.roleNameMax).default('yeni rol'),
  color: color.default('#99aab5'),
  permissions: permissions.default(0),
});

const patchRole = z.object({
  name: z.string().trim().min(1).max(LIMITS.roleNameMax).optional(),
  color: color.optional(),
  permissions: permissions.optional(),
});

const patchMember = z.object({
  nick: z.string().trim().max(LIMITS.displayNameMax).nullable().optional(),
  roleIds: z.array(id).max(250).optional(),
});

const createChannel = z.object({
  name: z.string().min(1).max(LIMITS.channelNameMax),
  type: z.enum(['text', 'voice', 'category']).default('text'),
  parentId: id.nullable().optional(),
  topic: z.string().max(LIMITS.topicMax).default(''),
});

export function guildRoutes(app: FastifyInstance, ctx: Ctx) {
  const { store, access, gateway, limits, files } = ctx;
  const auth = { preHandler: requireAuth(store, limits) };

  // Deletes a server with its channels, messages and files (the owner, or a platform operator).
  ctx.removeGuild = async (guildId) => {
    const memberIds = store.memberUserIds(guildId);
    const fileKeys = store.fileKeys(
      `SELECT a.file_key FROM attachments a JOIN messages m ON m.id = a.message_id
       JOIN channels c ON c.id = m.channel_id WHERE c.guild_id = ?`,
      guildId,
    );
    store.deleteGuild(guildId);
    await files.remove(fileKeys);
    gateway.dispatch(memberIds, 'GUILD_DELETE', { id: guildId });
    gateway.syncVoice(guildId);
  };

  // Resolves the guild and the caller's guild-level permissions, or throws.
  const load = (guildId: string, userId: string) => {
    const guild = store.guild(guildId);
    const perms = guild ? access.guildPerms(guildId, userId) : null;
    if (!guild || perms === null) throw notFound('Sunucu');
    return { guild, perms };
  };

  const removeFromGuild = (guildId: string, userId: string) => {
    store.removeMember(guildId, userId);
    gateway.dispatch([userId], 'GUILD_DELETE', { id: guildId });
    gateway.toGuild(guildId, 'GUILD_MEMBER_REMOVE', { guildId, userId });
    gateway.syncVoice(guildId);
  };

  app.post('/api/guilds', auth, async (req, reply) => {
    const { name } = z.object({ name: guildName }).parse(req.body);
    const state = store.createGuild(req.userId, name);
    gateway.dispatch([req.userId], 'GUILD_CREATE', gateway.guildSnapshotFor(state.guild.id, req.userId)!);
    return reply.code(201).send(state);
  });

  app.patch('/api/guilds/:guildId', auth, async (req) => {
    const { guildId } = z.object({ guildId: id }).parse(req.params);
    const { perms } = load(guildId, req.userId);
    const body = z.object({ name: guildName.optional(), ownerId: id.optional() }).parse(req.body);
    if (body.name !== undefined && !hasPerm(perms, Perm.ManageGuild)) throw forbidden();
    if (body.ownerId !== undefined) {
      // Only the owner can hand the server over, and only to a member.
      if (store.guild(guildId)!.ownerId !== req.userId) throw new HttpError(403, 'Sunucuyu yalnızca sahibi devredebilir');
      if (!store.member(guildId, body.ownerId)) throw new HttpError(400, 'Yeni sahip bu sunucunun üyesi olmalı');
    }
    const guild = store.updateGuild(guildId, body);
    if (body.ownerId !== undefined) gateway.resyncGuild(guildId);
    else gateway.toGuild(guildId, 'GUILD_UPDATE', guild);
    return guild;
  });

  app.delete('/api/guilds/:guildId', auth, async (req, reply) => {
    const { guildId } = z.object({ guildId: id }).parse(req.params);
    const { guild } = load(guildId, req.userId);
    if (guild.ownerId !== req.userId) throw new HttpError(403, 'Sunucuyu yalnızca sahibi silebilir');
    await ctx.removeGuild(guildId);
    return reply.code(204).send();
  });

  // ---------- members ----------

  app.delete('/api/guilds/:guildId/members/@me', auth, async (req, reply) => {
    const { guildId } = z.object({ guildId: id }).parse(req.params);
    const { guild } = load(guildId, req.userId);
    if (guild.ownerId === req.userId) throw new HttpError(400, 'Sunucu sahibi ayrılamaz; önce sunucuyu başkasına devret ya da sil');
    removeFromGuild(guildId, req.userId);
    return reply.code(204).send();
  });

  app.delete('/api/guilds/:guildId/members/:userId', auth, async (req, reply) => {
    const { guildId, userId } = z.object({ guildId: id, userId: id }).parse(req.params);
    const { guild, perms } = load(guildId, req.userId);
    if (!hasPerm(perms, Perm.KickMembers)) throw forbidden();
    if (!store.member(guildId, userId)) throw notFound('Üye');
    if (userId === guild.ownerId || userId === req.userId) throw new HttpError(400, 'Bu üye atılamaz');
    if (access.rank(guildId, userId) >= access.rank(guildId, req.userId)) {
      throw new HttpError(403, 'Senden yüksek veya eşit roldeki birini atamazsın');
    }
    removeFromGuild(guildId, userId);
    return reply.code(204).send();
  });

  // ---------- bans ----------

  app.get('/api/guilds/:guildId/bans', auth, async (req) => {
    const { guildId } = z.object({ guildId: id }).parse(req.params);
    const { perms } = load(guildId, req.userId);
    if (!hasPerm(perms, Perm.BanMembers)) throw forbidden();
    return store.guildBans(guildId);
  });

  // Ban: removed now, and invites no longer let them back in.
  app.put('/api/guilds/:guildId/bans/:userId', auth, async (req, reply) => {
    const { guildId, userId } = z.object({ guildId: id, userId: id }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().max(500).default('') }).parse(req.body ?? {});
    const { guild, perms } = load(guildId, req.userId);
    if (!hasPerm(perms, Perm.BanMembers)) throw forbidden();
    if (!store.user(userId)) throw notFound('Kullanıcı');
    if (userId === guild.ownerId || userId === req.userId) throw new HttpError(400, 'Bu kişi yasaklanamaz');
    if (store.member(guildId, userId) && access.rank(guildId, userId) >= access.rank(guildId, req.userId)) {
      throw new HttpError(403, 'Senden yüksek veya eşit roldeki birini yasaklayamazsın');
    }
    store.banFromGuild(guildId, userId, reason, req.userId);
    if (store.member(guildId, userId)) removeFromGuild(guildId, userId);
    return reply.code(204).send();
  });

  app.delete('/api/guilds/:guildId/bans/:userId', auth, async (req, reply) => {
    const { guildId, userId } = z.object({ guildId: id, userId: id }).parse(req.params);
    const { perms } = load(guildId, req.userId);
    if (!hasPerm(perms, Perm.BanMembers)) throw forbidden();
    if (!store.unbanFromGuild(guildId, userId)) throw notFound('Yasak');
    return reply.code(204).send();
  });

  app.patch('/api/guilds/:guildId/members/:userId', auth, async (req) => {
    const { guildId, userId } = z.object({ guildId: id, userId: id }).parse(req.params);
    const { perms } = load(guildId, req.userId);
    const member = store.member(guildId, userId);
    if (!member) throw notFound('Üye');
    const body = patchMember.parse(req.body);

    if (body.nick !== undefined && userId !== req.userId && !hasPerm(perms, Perm.ManageGuild)) throw forbidden();

    if (body.roleIds !== undefined) {
      if (!hasPerm(perms, Perm.ManageRoles)) throw forbidden();
      const myRank = access.rank(guildId, req.userId);
      const roles = new Map(store.roles(guildId).map((r) => [r.id, r]));
      const before = new Set(member.roleIds);
      const after = new Set(body.roleIds);
      for (const roleId of after) {
        const role = roles.get(roleId);
        if (!role || role.id === guildId) throw new HttpError(400, 'Geçersiz rol');
      }
      // Any role being added or removed must rank below the caller.
      for (const roleId of [...before, ...after]) {
        if (before.has(roleId) !== after.has(roleId) && (roles.get(roleId)?.position ?? 0) >= myRank) {
          throw new HttpError(403, 'Kendi en yüksek rolünden yüksek veya eşit bir rolü veremez/alamazsın');
        }
      }
    }

    const updated = store.updateMember(guildId, userId, {
      nick: body.nick === undefined ? undefined : body.nick || null,
      roleIds: body.roleIds,
    });
    if (body.roleIds !== undefined) gateway.resyncGuild(guildId);
    else gateway.toGuild(guildId, 'GUILD_MEMBER_UPDATE', updated);
    return updated;
  });

  // ---------- roles ----------

  // Non-owners may only hand out permissions they hold themselves.
  const assertGrantable = (perms: number, requested: number) => {
    if (perms !== ALL_PERMISSIONS && (requested & ~perms) !== 0) {
      throw new HttpError(403, 'Sahip olmadığın bir izni veremezsin');
    }
  };

  app.post('/api/guilds/:guildId/roles', auth, async (req, reply) => {
    const { guildId } = z.object({ guildId: id }).parse(req.params);
    const { perms } = load(guildId, req.userId);
    if (!hasPerm(perms, Perm.ManageRoles)) throw forbidden();
    const body = createRole.parse(req.body ?? {});
    assertGrantable(perms, body.permissions);
    const role = store.createRole(guildId, body);
    gateway.toGuild(guildId, 'GUILD_ROLE_CREATE', role);
    return reply.code(201).send(role);
  });

  app.patch('/api/guilds/:guildId/roles/:roleId', auth, async (req) => {
    const { guildId, roleId } = z.object({ guildId: id, roleId: id }).parse(req.params);
    const { perms } = load(guildId, req.userId);
    if (!hasPerm(perms, Perm.ManageRoles)) throw forbidden();
    const role = store.role(roleId);
    if (!role || role.guildId !== guildId) throw notFound('Rol');
    if (role.id !== guildId && role.position >= access.rank(guildId, req.userId)) {
      throw new HttpError(403, 'Kendi en yüksek rolünden yüksek veya eşit bir rolü düzenleyemezsin');
    }
    const body = patchRole.parse(req.body);
    if (role.id === guildId && body.name !== undefined) throw new HttpError(400, '@everyone rolünün adı değiştirilemez');
    if (body.permissions !== undefined) assertGrantable(perms, body.permissions);
    const updated = store.updateRole(roleId, body);
    gateway.resyncGuild(guildId);
    return updated;
  });

  app.delete('/api/guilds/:guildId/roles/:roleId', auth, async (req, reply) => {
    const { guildId, roleId } = z.object({ guildId: id, roleId: id }).parse(req.params);
    const { perms } = load(guildId, req.userId);
    if (!hasPerm(perms, Perm.ManageRoles)) throw forbidden();
    const role = store.role(roleId);
    if (!role || role.guildId !== guildId) throw notFound('Rol');
    if (role.id === guildId) throw new HttpError(400, '@everyone rolü silinemez');
    if (role.position >= access.rank(guildId, req.userId)) throw forbidden();
    store.deleteRole(roleId);
    gateway.resyncGuild(guildId);
    return reply.code(204).send();
  });

  // ---------- channels ----------

  app.post('/api/guilds/:guildId/channels', auth, async (req, reply) => {
    const { guildId } = z.object({ guildId: id }).parse(req.params);
    const { perms } = load(guildId, req.userId);
    if (!hasPerm(perms, Perm.ManageChannels)) throw forbidden();
    const body = createChannel.parse(req.body);
    // Text channels use slug names; voice channels and categories keep the name as typed.
    const name = body.type === 'text' ? channelName(body.name) : body.name.trim().slice(0, LIMITS.channelNameMax);
    if (!name) throw new HttpError(400, 'Geçersiz kanal adı');
    let parentId: string | null = null;
    if (body.type !== 'category' && body.parentId) {
      const parent = store.channel(body.parentId);
      if (!parent || parent.guildId !== guildId || parent.type !== 'category') throw new HttpError(400, 'Geçersiz kategori');
      parentId = parent.id;
    }
    const channel = store.createChannel({ guildId, type: body.type, name, parentId, topic: body.topic });
    gateway.toViewers(channel, 'CHANNEL_CREATE', channel);
    return reply.code(201).send(channel);
  });

  // ---------- invites (preview & join) ----------

  const liveInvite = (code: string) => {
    const invite = store.invite(code);
    if (!invite) throw notFound('Davet');
    if (invite.expiresAt !== null && invite.expiresAt < Date.now()) throw new HttpError(410, 'Davetin süresi dolmuş');
    if (invite.maxUses > 0 && invite.uses >= invite.maxUses) throw new HttpError(410, 'Davetin kullanım hakkı dolmuş');
    return invite;
  };

  app.get('/api/invites/:code', async (req) => {
    const { code } = z.object({ code: z.string().max(32) }).parse(req.params);
    const invite = liveInvite(code);
    return { code, guild: store.guild(invite.guildId)!, memberCount: store.memberCount(invite.guildId) };
  });

  app.post('/api/invites/:code', auth, async (req) => {
    const { code } = z.object({ code: z.string().max(32) }).parse(req.params);
    const invite = liveInvite(code);
    if (store.isBannedFromGuild(invite.guildId, req.userId)) throw new HttpError(403, 'Bu sunucudan yasaklandın');
    if (!store.member(invite.guildId, req.userId)) {
      const member = store.addMember(invite.guildId, req.userId);
      store.useInvite(code);
      gateway.dispatch(
        store.memberUserIds(invite.guildId).filter((u) => u !== req.userId),
        'GUILD_MEMBER_ADD',
        { member, user: store.user(req.userId)! },
      );
      gateway.dispatch(store.memberUserIds(invite.guildId), 'PRESENCE_UPDATE', {
        userId: req.userId,
        status: gateway.isOnline(req.userId) ? 'online' : 'offline',
      });
    }
    const snapshot = gateway.guildSnapshotFor(invite.guildId, req.userId)!;
    gateway.dispatch([req.userId], 'GUILD_CREATE', snapshot);
    return snapshot;
  });
}
