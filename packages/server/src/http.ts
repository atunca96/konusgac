import type { Message } from '@konusgac/shared';
import type { GoogleAuth } from './google';
import type { Mailer } from './mail';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import type { Access } from './access';
import { hashToken } from './auth';
import type { ServerConfig } from './config';
import type { Files } from './files';
import type { Gateway } from './gateway';
import type { RateLimiter, RuleName } from './ratelimit';
import type { Store } from './store';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} bulunamadı`);
export const forbidden = () => new HttpError(403, 'Bu işlem için yetkin yok');

export interface Ctx {
  store: Store;
  access: Access;
  gateway: Gateway;
  limits: RateLimiter;
  files: Files;
  config: ServerConfig;
  downloads: string; // folder with the Windows installer and its update files, served at /indir/
  mailer: Mailer | null; // null: this server sends no e-mail
  google: GoogleAuth | null; // null: no Google sign-in
  sendVerification?: (userId: string, email: string) => Promise<void>; // set by routes/account.ts
  isSiteAdmin(userId: string): boolean;
  removeMessage(message: Message): Promise<void>; // deletes it with its files and tells everyone (routes/channels.ts)
  removeGuild(guildId: string): Promise<void>; // deletes a server with everything in it (routes/guilds.ts)
}

export const INSTALLER = 'Konusgac-Kurulum.exe'; // in ctx.downloads

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
  // Which rate-limit bucket an authenticated route spends from; changes default to 'write'.
  interface FastifyContextConfig {
    limit?: RuleName | 'none';
  }
}

export function installErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      if ('retryAfterMs' in err) reply.header('retry-after', Math.max(1, Math.ceil((err.retryAfterMs as number) / 1000)));
      return reply.code(err.status).send({ error: err.message });
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const field = issue?.path.join('.') || 'istek';
      return reply.code(400).send({ error: `Geçersiz ${field}: ${issue?.message ?? ''}`.trim() });
    }
    const { statusCode: status, message } = err as { statusCode?: number; message?: string };
    if (status && status < 500) return reply.code(status).send({ error: message ?? 'Geçersiz istek' });
    req.log.error(err);
    return reply.code(500).send({ error: 'Sunucu hatası' });
  });
}

// Resolves the session and spends the route's rate-limit bucket (reads are free).
export function requireAuth(store: Store, limits?: RateLimiter) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const userId = token ? store.sessionUserId(hashToken(token)) : undefined;
    if (!userId) throw new HttpError(401, 'Oturum açman gerekiyor');
    req.userId = userId;
    const rule = req.routeOptions.config?.limit ?? (req.method === 'GET' ? 'none' : 'write');
    if (limits && rule !== 'none') limits.check(rule, userId);
  };
}

export const id = z.string().regex(/^\d{1,20}$/, 'kimlik biçimi');
export const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'renk #rrggbb olmalı');

// Channel names follow the "kucuk-harf-ve-tire" style.
export function channelName(raw: string): string {
  return raw
    .trim()
    .toLocaleLowerCase('tr')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 100);
}
