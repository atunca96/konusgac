import { Perm, REPORT_REASONS, type ReportReason } from '@konusgac/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden, HttpError, id, notFound, requireAuth, type Ctx } from '../http';
import type { Mail } from '../mail';

// Reports and the platform's own moderation.
//
// Anyone can report a message they can see; the message's text is copied into the report, so
// it stays as evidence even if it is deleted, and the operator gets an e-mail. The operators
// (KONUSGAC_YONETICILER: user names) see the reports in Ayarlar → Platform yönetimi and can delete
// any message, remove any server and ban accounts from the whole platform, which is what a
// hosting provider must be able to do under Law 5651.

const reason = z.enum(Object.keys(REPORT_REASONS) as [ReportReason, ...ReportReason[]]);

export function moderationRoutes(app: FastifyInstance, ctx: Ctx) {
  const { store, access, gateway, limits, config, mailer } = ctx;
  const auth = { preHandler: requireAuth(store, limits) };

  const requireAdmin = (req: FastifyRequest) => {
    if (!ctx.isSiteAdmin(req.userId)) throw forbidden();
  };

  // ---------- reports ----------

  app.post('/api/reports', { ...auth, config: { limit: 'report' } }, async (req, reply) => {
    const body = z.object({ messageId: id, reason, note: z.string().trim().max(1000).default('') }).parse(req.body);
    const message = store.message(body.messageId);
    const channel = message && store.channel(message.channelId);
    // Only what the reporter can see can be reported.
    if (!message || !channel || !access.can(channel, req.userId, Perm.ViewChannel)) throw notFound('Mesaj');
    if (message.authorId === req.userId) throw new HttpError(400, 'Kendi mesajını şikâyet edemezsin');
    store.createReport({ reporterId: req.userId, message, guildId: channel.guildId, reason: body.reason, note: body.note });
    if (mailer && config.contactEmail) {
      void mailer(reportMail(config.contactEmail, config.publicUrl ?? '', body.reason, message.content, body.note)).catch((err) =>
        app.log.error({ err }, 'Şikâyet e-postası gönderilemedi'),
      );
    }
    return reply.code(204).send();
  });

  app.get('/api/admin/reports', auth, async (req) => {
    requireAdmin(req);
    const { status } = z.object({ status: z.enum(['open', 'resolved']).default('open') }).parse(req.query);
    return store.reports(status);
  });

  app.post('/api/admin/reports/:reportId/resolve', auth, async (req, reply) => {
    requireAdmin(req);
    const { reportId } = z.object({ reportId: id }).parse(req.params);
    if (!store.resolveReport(reportId, req.userId)) throw notFound('Şikâyet');
    return reply.code(204).send();
  });

  // ---------- content ----------

  app.delete('/api/admin/messages/:messageId', auth, async (req, reply) => {
    requireAdmin(req);
    const { messageId } = z.object({ messageId: id }).parse(req.params);
    const message = store.message(messageId);
    if (!message) throw notFound('Mesaj');
    await ctx.removeMessage(message);
    return reply.code(204).send();
  });

  app.delete('/api/admin/guilds/:guildId', auth, async (req, reply) => {
    requireAdmin(req);
    const { guildId } = z.object({ guildId: id }).parse(req.params);
    if (!store.guild(guildId)) throw notFound('Sunucu');
    await ctx.removeGuild(guildId);
    return reply.code(204).send();
  });

  // ---------- platform bans ----------

  app.get('/api/admin/bans', auth, async (req) => {
    requireAdmin(req);
    return store.platformBans();
  });

  app.put('/api/admin/users/:userId/ban', auth, async (req, reply) => {
    requireAdmin(req);
    const { userId } = z.object({ userId: id }).parse(req.params);
    const body = z.object({ reason: z.string().trim().max(500).default(''), deleteRecentMessages: z.boolean().default(false) }).parse(req.body ?? {});
    if (!store.user(userId)) throw notFound('Kullanıcı');
    if (ctx.isSiteAdmin(userId)) throw new HttpError(400, 'Bir yönetici yasaklanamaz');
    store.banUser(userId, body.reason);
    gateway.disconnectUser(userId);
    // Spam clean-up: their messages from the last 24 hours go too.
    if (body.deleteRecentMessages) {
      for (const m of store.recentMessageIds(userId, 24 * 60 * 60_000)) {
        const message = store.message(m.id);
        if (message) await ctx.removeMessage(message);
      }
    }
    return reply.code(204).send();
  });

  app.delete('/api/admin/users/:userId/ban', auth, async (req, reply) => {
    requireAdmin(req);
    const { userId } = z.object({ userId: id }).parse(req.params);
    store.unbanUser(userId);
    return reply.code(204).send();
  });
}

function reportMail(to: string, site: string, reason: ReportReason, content: string, note: string): Mail {
  const text = [
    `Konuşgaç'ta bir mesaj şikâyet edildi: ${REPORT_REASONS[reason]}.`,
    '',
    `Mesaj: ${content || '(yalnızca dosya)'}`,
    note ? `Şikâyet edenin notu: ${note}` : '',
    '',
    `İncelemek için: ${site} → Ayarlar → Platform yönetimi`,
  ].join('\n');
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return {
    to,
    subject: `Konuşgaç: yeni şikâyet (${REPORT_REASONS[reason]})`,
    text,
    html: `<pre style="font:14px Segoe UI,Arial,sans-serif;white-space:pre-wrap">${esc(text)}</pre>`,
  };
}
