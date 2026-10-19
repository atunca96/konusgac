import { LIMITS, type User } from '@konusgac/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, hashToken, verifyPassword } from '../auth';
import { color, HttpError, id, notFound, requireAuth, type Ctx } from '../http';
import { password } from './auth';

const patchMe = z.object({
  displayName: z.string().trim().min(1).max(LIMITS.displayNameMax).optional(),
  avatarColor: color.optional(),
});

const addFriend = z.union([z.object({ username: z.string().trim().min(1) }), z.object({ userId: id })]);

const openDm = z.object({ recipientId: id });

const privacy = z.object({
  dmFromServerMembers: z.boolean(),
  friendRequests: z.object({ everyone: z.boolean(), friendsOfFriends: z.boolean(), serverMembers: z.boolean() }),
});

const tokenHashOf = (header: string | undefined) => hashToken((header ?? '').slice(7));

// Friends may always message each other; otherwise the recipient's setting decides.
export function dmAllowedBy(store: Ctx['store']) {
  return (from: string, to: string) => store.relationship(from, to) === 'friend' || store.privacy(to).dmFromServerMembers;
}

export function userRoutes(app: FastifyInstance, { store, gateway, limits }: Ctx) {
  const dmAllowed = dmAllowedBy(store);
  const auth = { preHandler: requireAuth(store, limits) };

  app.get('/api/users/@me', auth, async (req) => store.user(req.userId)!);

  // ---------- privacy ----------

  app.get('/api/users/@me/settings', auth, async (req) => store.privacy(req.userId));

  app.patch('/api/users/@me/settings', auth, async (req) => store.setPrivacy(req.userId, privacy.parse(req.body)));

  // ---------- devices ----------

  app.get('/api/users/@me/sessions', auth, async (req) => store.sessions(req.userId, tokenHashOf(req.headers.authorization)));

  app.delete('/api/users/@me/sessions/:sessionId', auth, async (req, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().regex(/^[0-9a-f]{16}$/) }).parse(req.params);
    if (!store.deleteSessionById(req.userId, sessionId)) throw notFound('Oturum');
    return reply.code(204).send();
  });

  // Signs out every device except this one.
  app.delete('/api/users/@me/sessions', auth, async (req, reply) => {
    store.deleteOtherSessions(req.userId, tokenHashOf(req.headers.authorization));
    return reply.code(204).send();
  });

  const checkPassword = async (userId: string, given: string) => {
    limits.check('password', userId);
    if (!(await verifyPassword(given, store.passwordHashById(userId) ?? ''))) throw new HttpError(403, 'Mevcut şifre yanlış');
  };

  // New password; every other device is signed out. An account made with Google sets its first
  // password without a current one.
  app.put('/api/users/@me/password', auth, async (req, reply) => {
    const body = z.object({ currentPassword: z.string().max(LIMITS.passwordMax).default(''), newPassword: password }).parse(req.body);
    if (store.account(req.userId).hasPassword) await checkPassword(req.userId, body.currentPassword);
    const token = (req.headers.authorization ?? '').slice(7);
    store.setPassword(req.userId, await hashPassword(body.newPassword), hashToken(token));
    return reply.code(204).send();
  });

  app.delete('/api/users/@me', auth, async (req, reply) => {
    const body = z.object({ password: z.string().max(LIMITS.passwordMax) }).parse(req.body);
    // Without a password (Google account), typing the user name confirms the deletion.
    if (store.account(req.userId).hasPassword) await checkPassword(req.userId, body.password);
    else if (body.password.toLowerCase() !== store.user(req.userId)!.username.toLowerCase()) throw new HttpError(403, 'Onay için kullanıcı adını yaz');
    if (store.ownedGuildIds(req.userId).length > 0) {
      throw new HttpError(400, 'Önce sahibi olduğun sunucuları başkasına devret ya da sil');
    }
    gateway.disconnectUser(req.userId);
    const audience = store.relatedUserIds(req.userId); // everyone who saw the old name
    const { guildIds, relatedIds } = store.deleteAccount(req.userId);
    for (const guildId of guildIds) {
      gateway.toGuild(guildId, 'GUILD_MEMBER_REMOVE', { guildId, userId: req.userId });
      gateway.syncVoice(guildId);
    }
    gateway.dispatch(relatedIds, 'RELATIONSHIP_REMOVE', { userId: req.userId });
    gateway.dispatch(audience, 'USER_UPDATE', store.user(req.userId)!);
    return reply.code(204).send();
  });

  app.patch('/api/users/@me', auth, async (req) => {
    const body = patchMe.parse(req.body);
    const user = store.updateUser(req.userId, body);
    gateway.dispatch(store.relatedUserIds(req.userId), 'USER_UPDATE', user);
    return user;
  });

  // Send a friend request, or accept one that the other user already sent.
  app.post('/api/users/@me/relationships', auth, async (req, reply) => {
    const body = addFriend.parse(req.body);
    const target: User | undefined = 'username' in body ? store.userByUsername(body.username) : store.user(body.userId);
    if (!target) throw notFound('Kullanıcı');
    if (target.id === req.userId) throw new HttpError(400, 'Kendine arkadaşlık isteği gönderemezsin');

    const me = store.user(req.userId)!;
    const current = store.relationship(req.userId, target.id);
    if (current === 'friend') throw new HttpError(409, 'Zaten arkadaşsınız');
    if (current === 'outgoing') throw new HttpError(409, 'Arkadaşlık isteği zaten gönderildi');

    if (current !== 'incoming') {
      // The recipient decides who may send requests.
      const rules = store.privacy(target.id).friendRequests;
      const allowed =
        rules.everyone ||
        (rules.serverMembers && store.sharesGuild(req.userId, target.id)) ||
        (rules.friendsOfFriends && store.hasMutualFriend(req.userId, target.id));
      if (!allowed) throw new HttpError(403, 'Bu kişi arkadaşlık isteklerini kabul etmiyor');
    }

    if (current === 'incoming') {
      store.setRelationship(req.userId, target.id, 'friend');
      store.setRelationship(target.id, req.userId, 'friend');
      gateway.dispatch([req.userId], 'RELATIONSHIP_ADD', { relationship: { userId: target.id, type: 'friend' }, user: target });
      gateway.dispatch([target.id], 'RELATIONSHIP_ADD', { relationship: { userId: req.userId, type: 'friend' }, user: me });
    } else {
      store.setRelationship(req.userId, target.id, 'outgoing');
      store.setRelationship(target.id, req.userId, 'incoming');
      gateway.dispatch([req.userId], 'RELATIONSHIP_ADD', { relationship: { userId: target.id, type: 'outgoing' }, user: target });
      gateway.dispatch([target.id], 'RELATIONSHIP_ADD', { relationship: { userId: req.userId, type: 'incoming' }, user: me });
    }
    return reply.code(204).send();
  });

  app.delete('/api/users/@me/relationships/:userId', auth, async (req, reply) => {
    const { userId } = z.object({ userId: id }).parse(req.params);
    if (!store.relationship(req.userId, userId)) throw notFound('İlişki');
    store.deleteRelationshipPair(req.userId, userId);
    gateway.dispatch([req.userId], 'RELATIONSHIP_REMOVE', { userId });
    gateway.dispatch([userId], 'RELATIONSHIP_REMOVE', { userId: req.userId });
    return reply.code(204).send();
  });

  // DMs are open to friends and to people who share a server.
  app.post('/api/users/@me/channels', auth, async (req) => {
    const { recipientId } = openDm.parse(req.body);
    if (recipientId === req.userId) throw new HttpError(400, 'Kendine mesaj kanalı açamazsın');
    if (!store.user(recipientId)) throw notFound('Kullanıcı');
    if (!store.relatedUserIds(req.userId).has(recipientId)) {
      throw new HttpError(403, 'Bu kişiyle ortak sunucun veya arkadaşlığın yok');
    }
    if (!dmAllowed(req.userId, recipientId)) throw new HttpError(403, 'Bu kişi sunucu üyelerinden özel mesaj kabul etmiyor');
    const { channel, created } = store.openDm(req.userId, recipientId);
    if (created) gateway.dispatch(channel.recipientIds, 'CHANNEL_CREATE', channel);
    return channel;
  });
}
