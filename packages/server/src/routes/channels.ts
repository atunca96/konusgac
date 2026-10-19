import { LIMITS, mentionedUserIds, mentionsEveryone, Perm, type Channel, type Message } from '@konusgac/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { safeFilename, sniffType } from '../files';
import { channelName, forbidden, HttpError, id, notFound, requireAuth, type Ctx } from '../http';
import type { NewAttachment } from '../store';
import { dmAllowedBy } from './users';

const content = z.string().trim().max(LIMITS.messageMax, `en fazla ${LIMITS.messageMax} karakter`);

const newMessage = z.object({
  content: content.default(''),
  replyToId: id.nullable().optional(),
});

// One emoji (with skin tones, ZWJ sequences, keycaps or a flag), not arbitrary text.
const emoji = z
  .string()
  .refine((e) => Buffer.byteLength(e) <= LIMITS.emojiMax, 'emoji çok uzun')
  .refine(
    (e) => /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\u20e3]+$/u.test(e) && /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(e),
    'geçerli bir emoji değil',
  );

const search = z.object({
  q: z.string().trim().min(1, 'arama boş olamaz').max(LIMITS.searchQueryMax),
  guildId: id.optional(),
  channelId: id.optional(),
  before: id.optional(),
});

const overwrite = z.object({
  roleId: id,
  allow: z.number().int().min(0),
  deny: z.number().int().min(0),
});

const patchChannel = z.object({
  name: z.string().min(1).max(LIMITS.channelNameMax).optional(),
  topic: z.string().max(LIMITS.topicMax).optional(),
  parentId: id.nullable().optional(),
  position: z.number().int().min(0).optional(),
  overwrites: z.array(overwrite).max(100).optional(),
});

const history = z.object({
  before: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(LIMITS.historyPage),
});

const createInvite = z.object({
  maxUses: z.number().int().min(0).max(1000).default(0),
  maxAgeSeconds: z.number().int().min(0).max(30 * 86400).default(7 * 86400),
});

export function channelRoutes(app: FastifyInstance, ctx: Ctx) {
  const { store, access, gateway, limits, files, config } = ctx;

  // Deletes a message with its files and tells everyone who can see it (also used by moderation).
  ctx.removeMessage = async (message) => {
    const channel = store.channel(message.channelId);
    await files.remove(store.deleteMessage(message.id));
    if (channel) gateway.toViewers(channel, 'MESSAGE_DELETE', { id: message.id, channelId: message.channelId });
  };
  const auth = { preHandler: requireAuth(store, limits) };
  const authAs = (limit: 'message' | 'reaction' | 'typing' | 'search' | 'none') => ({ ...auth, config: { limit } });
  const dmAllowed = dmAllowedBy(store);

  // Channels the caller cannot see are reported as missing, not forbidden.
  const visible = (channelId: string, userId: string): Channel => {
    const channel = store.channel(channelId);
    if (!channel || !access.can(channel, userId, Perm.ViewChannel)) throw notFound('Kanal');
    return channel;
  };

  const textChannel = (channelId: string, userId: string): Channel => {
    const channel = visible(channelId, userId);
    if (channel.type === 'category') throw new HttpError(400, 'Kategorilere mesaj gönderilemez');
    if (channel.type === 'voice') throw new HttpError(400, 'Sesli kanallara mesaj gönderilemez');
    return channel;
  };

  app.patch('/api/channels/:channelId', auth, async (req) => {
    const { channelId } = z.object({ channelId: id }).parse(req.params);
    const channel = visible(channelId, req.userId);
    if (channel.type === 'dm' || !access.can(channel, req.userId, Perm.ManageChannels)) throw forbidden();
    const body = patchChannel.parse(req.body);
    const guildId = channel.guildId!;

    if (body.overwrites !== undefined) {
      if (!access.can(channel, req.userId, Perm.ManageRoles)) throw forbidden();
      const roleIds = new Set(store.roles(guildId).map((r) => r.id));
      if (body.overwrites.some((o) => !roleIds.has(o.roleId))) throw new HttpError(400, 'Geçersiz rol');
    }
    if (body.parentId) {
      const parent = store.channel(body.parentId);
      if (channel.type === 'category' || !parent || parent.guildId !== guildId || parent.type !== 'category') {
        throw new HttpError(400, 'Geçersiz kategori');
      }
    }
    let name = body.name;
    if (name !== undefined) {
      name = channel.type === 'text' ? channelName(name) : name.trim();
      if (!name) throw new HttpError(400, 'Geçersiz kanal adı');
    }

    const updated = store.updateChannel(channelId, { ...body, name });
    if (body.overwrites !== undefined) gateway.resyncGuild(guildId);
    else gateway.toViewers(updated, 'CHANNEL_UPDATE', updated);
    return updated;
  });

  app.delete('/api/channels/:channelId', auth, async (req, reply) => {
    const { channelId } = z.object({ channelId: id }).parse(req.params);
    const channel = visible(channelId, req.userId);
    if (channel.type === 'dm' || !access.can(channel, req.userId, Perm.ManageChannels)) throw forbidden();
    const memberIds = store.memberUserIds(channel.guildId!);
    const fileKeys = store.fileKeys(
      'SELECT a.file_key FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id = ?',
      channelId,
    );
    const orphaned = store.deleteChannel(channelId);
    await files.remove(fileKeys);
    gateway.dispatch(memberIds, 'CHANNEL_DELETE', { id: channelId, guildId: channel.guildId });
    for (const child of orphaned) gateway.toViewers(child, 'CHANNEL_UPDATE', child);
    gateway.syncVoice(channel.guildId!);
    return reply.code(204).send();
  });

  // ---------- messages ----------

  app.get('/api/channels/:channelId/messages', auth, async (req) => {
    const { channelId } = z.object({ channelId: id }).parse(req.params);
    const channel = textChannel(channelId, req.userId);
    if (!access.can(channel, req.userId, Perm.ReadHistory)) return [];
    const q = history.parse(req.query);
    return store.messages(channelId, q.before ?? null, q.limit);
  });

  // Who a message notifies: users it names with <@id> who can see the channel, and everyone
  // for @everyone when the author may use it.
  const mentions = (channel: Channel, authorId: string, text: string) => {
    const viewers = new Set(access.viewers(channel));
    const mentionIds = mentionedUserIds(text).filter((u) => viewers.has(u));
    const everyone = channel.type !== 'dm' && mentionsEveryone(text) && access.can(channel, authorId, Perm.MentionEveryone);
    return { mentionIds, mentionEveryone: everyone, viewers };
  };

  // A JSON body, or multipart with a `payload_json` field and up to 10 files.
  const readMessage = async (req: FastifyRequest, channel: Channel) => {
    if (!req.isMultipart()) return { ...newMessage.parse(req.body ?? {}), uploads: [] as { name: string; data: Buffer }[] };
    let payload: unknown = {};
    const uploads: { name: string; data: Buffer }[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname !== 'payload_json') continue;
        try {
          payload = JSON.parse(String(part.value));
        } catch {
          throw new HttpError(400, 'Geçersiz payload_json');
        }
      } else {
        if (!access.can(channel, req.userId, Perm.AttachFiles)) throw new HttpError(403, 'Bu kanala dosya ekleme iznin yok');
        limits.check('upload', req.userId);
        const data = await part.toBuffer();
        if (part.file.truncated) {
          throw new HttpError(413, `Dosya çok büyük; en fazla ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`);
        }
        if (data.length === 0) continue;
        uploads.push({ name: safeFilename(part.filename), data });
      }
    }
    return { ...newMessage.parse(payload), uploads };
  };

  app.post('/api/channels/:channelId/messages', authAs('message'), async (req, reply) => {
    const { channelId } = z.object({ channelId: id }).parse(req.params);
    const channel = textChannel(channelId, req.userId);
    if (!access.can(channel, req.userId, Perm.SendMessages)) throw new HttpError(403, 'Bu kanala mesaj gönderme iznin yok');
    const other = channel.type === 'dm' ? channel.recipientIds.find((u) => u !== req.userId) : undefined;
    if (other && !dmAllowed(req.userId, other)) throw new HttpError(403, 'Bu kişi sunucu üyelerinden özel mesaj kabul etmiyor');
    const body = await readMessage(req, channel);
    if (!body.content && body.uploads.length === 0) throw new HttpError(400, 'Mesaj boş olamaz');
    if (body.replyToId) {
      const target = store.message(body.replyToId);
      if (!target || target.channelId !== channelId) throw new HttpError(400, 'Yanıtlanan mesaj bu kanalda değil');
    }
    const { mentionIds, mentionEveryone, viewers } = mentions(channel, req.userId, body.content);

    const saved: NewAttachment[] = [];
    try {
      for (const u of body.uploads) {
        saved.push({ fileKey: await files.save(u.data), filename: u.name, size: u.data.length, contentType: sniffType(u.data.subarray(0, 16)) });
      }
      const message = store.createMessage({
        channelId,
        authorId: req.userId,
        content: body.content,
        replyToId: body.replyToId ?? null,
        mentionIds,
        mentionEveryone,
        attachments: saved,
      });
      // Unread badges: DMs count every message, servers count mentions (and replies to you).
      const notified = new Set<string>(channel.type === 'dm' ? channel.recipientIds : mentionEveryone ? viewers : mentionIds);
      const repliedTo = message.replyTo?.authorId;
      if (repliedTo && viewers.has(repliedTo)) notified.add(repliedTo);
      notified.delete(req.userId);
      store.addMentions(channelId, notified);
      store.ack(req.userId, channelId, message.id);
      gateway.toViewers(channel, 'MESSAGE_CREATE', message);
      return reply.code(201).send(message);
    } catch (err) {
      await files.remove(saved.map((a) => a.fileKey));
      throw err;
    }
  });

  app.patch('/api/channels/:channelId/messages/:messageId', auth, async (req) => {
    const { channelId, messageId } = z.object({ channelId: id, messageId: id }).parse(req.params);
    const channel = textChannel(channelId, req.userId);
    const message = store.message(messageId);
    if (!message || message.channelId !== channelId) throw notFound('Mesaj');
    if (message.authorId !== req.userId) throw new HttpError(403, 'Yalnızca kendi mesajını düzenleyebilirsin');
    const body = z.object({ content }).parse(req.body);
    if (!body.content && message.attachments.length === 0) throw new HttpError(400, 'Mesaj boş olamaz');
    const { mentionIds, mentionEveryone } = mentions(channel, req.userId, body.content);
    const updated = store.updateMessage(messageId, { content: body.content, mentionIds, mentionEveryone });
    gateway.toViewers(channel, 'MESSAGE_UPDATE', updated);
    return updated;
  });

  app.delete('/api/channels/:channelId/messages/:messageId', auth, async (req, reply) => {
    const { channelId, messageId } = z.object({ channelId: id, messageId: id }).parse(req.params);
    const channel = textChannel(channelId, req.userId);
    const message = store.message(messageId);
    if (!message || message.channelId !== channelId) throw notFound('Mesaj');
    if (message.authorId !== req.userId && !access.can(channel, req.userId, Perm.ManageMessages)) throw forbidden();
    await ctx.removeMessage(message);
    return reply.code(204).send();
  });

  // ---------- reactions ----------

  const reactionTarget = (req: FastifyRequest) => {
    const p = z.object({ channelId: id, messageId: id, emoji }).parse(req.params);
    const channel = textChannel(p.channelId, req.userId);
    if (!access.can(channel, req.userId, Perm.ReadHistory)) throw forbidden();
    const message = store.message(p.messageId);
    if (!message || message.channelId !== p.channelId) throw notFound('Mesaj');
    return { channel, message, emoji: p.emoji };
  };

  app.put('/api/channels/:channelId/messages/:messageId/reactions/:emoji/@me', authAs('reaction'), async (req, reply) => {
    const { channel, message, emoji: e } = reactionTarget(req);
    // Joining an existing reaction is always allowed; starting a new one needs AddReactions.
    if (!store.hasReaction(message.id, e)) {
      if (!access.can(channel, req.userId, Perm.AddReactions)) throw new HttpError(403, 'Bu kanalda tepki ekleme iznin yok');
      if (store.reactionEmojiCount(message.id) >= LIMITS.reactionsPerMessage) throw new HttpError(400, 'Bu mesajda çok fazla tepki var');
    }
    if (store.addReaction(message.id, req.userId, e)) {
      gateway.toViewers(channel, 'MESSAGE_REACTION_ADD', { channelId: channel.id, messageId: message.id, userId: req.userId, emoji: e });
    }
    return reply.code(204).send();
  });

  app.delete('/api/channels/:channelId/messages/:messageId/reactions/:emoji/@me', authAs('reaction'), async (req, reply) => {
    const { channel, message, emoji: e } = reactionTarget(req);
    if (store.removeReaction(message.id, req.userId, e)) {
      gateway.toViewers(channel, 'MESSAGE_REACTION_REMOVE', { channelId: channel.id, messageId: message.id, userId: req.userId, emoji: e });
    }
    return reply.code(204).send();
  });

  // ---------- read state ----------

  app.post('/api/channels/:channelId/ack', authAs('none'), async (req, reply) => {
    const { channelId } = z.object({ channelId: id }).parse(req.params);
    const channel = visible(channelId, req.userId);
    // manual: "Okunmadı olarak işaretle", which may move the read mark back.
    const { messageId, manual } = z.object({ messageId: id, manual: z.boolean().default(false) }).parse(req.body);
    if (!channel.lastMessageId || BigInt(messageId) > BigInt(channel.lastMessageId)) throw new HttpError(400, 'Geçersiz mesaj');
    const state = manual ? store.setReadMark(req.userId, channelId, messageId) : store.ack(req.userId, channelId, messageId);
    gateway.dispatch([req.userId], 'MESSAGE_ACK', state);
    return reply.code(204).send();
  });

  // ---------- search ----------

  // Searches one channel, one server's readable channels, or (with neither) the caller's DMs.
  app.get('/api/search', authAs('search'), async (req): Promise<{ messages: Message[]; hasMore: boolean }> => {
    const q = search.parse(req.query);
    limits.check('search', req.userId);
    let channels: Channel[];
    if (q.channelId) channels = [visible(q.channelId, req.userId)];
    else if (q.guildId) {
      if (!store.member(q.guildId, req.userId)) throw notFound('Sunucu');
      channels = store.guildChannels(q.guildId);
    } else channels = store.dmChannels(req.userId);
    const ids = channels
      .filter((c) => (c.type === 'text' || c.type === 'dm') && access.can(c, req.userId, Perm.ViewChannel | Perm.ReadHistory))
      .map((c) => c.id);
    const found = store.search(ids, q.q, q.before ?? null, LIMITS.searchPage + 1);
    return { messages: found.slice(0, LIMITS.searchPage), hasMore: found.length > LIMITS.searchPage };
  });

  app.post('/api/channels/:channelId/typing', authAs('typing'), async (req, reply) => {
    const { channelId } = z.object({ channelId: id }).parse(req.params);
    const channel = textChannel(channelId, req.userId);
    if (access.can(channel, req.userId, Perm.SendMessages)) {
      gateway.toViewers(channel, 'TYPING_START', { channelId, userId: req.userId }, req.userId);
    }
    return reply.code(204).send();
  });

  // ---------- invites ----------

  app.post('/api/channels/:channelId/invites', auth, async (req, reply) => {
    const { channelId } = z.object({ channelId: id }).parse(req.params);
    const channel = visible(channelId, req.userId);
    if (channel.type === 'category') throw new HttpError(400, 'Kategoriler için davet oluşturulamaz');
    if (channel.type === 'dm' || !access.can(channel, req.userId, Perm.CreateInvite)) throw forbidden();
    const body = createInvite.parse(req.body ?? {});
    const expiresAt = body.maxAgeSeconds > 0 ? Date.now() + body.maxAgeSeconds * 1000 : null;
    const invite = store.createInvite(channel.guildId!, channelId, req.userId, body.maxUses, expiresAt);
    return reply.code(201).send(invite);
  });
}
