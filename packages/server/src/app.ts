import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { LIMITS } from '@konusgac/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Access } from './access';
import { configFromEnv, type ServerConfig } from './config';
import { openDb } from './db';
import { Files } from './files';
import { Gateway } from './gateway';
import { googleAuth, type GoogleAuth } from './google';
import { resendMailer, type Mailer } from './mail';
import { accountRoutes } from './routes/account';
import { moderationRoutes } from './routes/moderation';
import { installErrorHandler, INSTALLER, type Ctx } from './http';
import { DEFAULT_RULES, RateLimiter, type Rules } from './ratelimit';
import { authRoutes } from './routes/auth';
import { channelRoutes } from './routes/channels';
import { guildRoutes } from './routes/guilds';
import { userRoutes } from './routes/users';
import { Store } from './store';

export interface AppOptions {
  dbPath: string;
  dataDir?: string; // attachments live here; defaults to the database's folder (a temp folder for :memory:)
  webRoot?: string; // built web client to serve, if present
  logger?: boolean;
  heartbeatInterval?: number;
  rateLimits?: Partial<Rules> | false; // false turns rate limiting off (tests)
  trustProxy?: boolean; // behind a reverse proxy: take the client IP from X-Forwarded-For
  config?: Partial<ServerConfig>;
  mailer?: Mailer; // replaces Resend (tests)
  google?: GoogleAuth; // replaces the real Google (tests)
}

// Content-Security-Policy for the web client: only our own scripts, no framing, no plugins.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function createApp(opts: AppOptions): Promise<{ app: FastifyInstance } & Ctx> {
  const config: ServerConfig = { ...configFromEnv(), ...opts.config };
  const dataDir =
    opts.dataDir ?? (opts.dbPath === ':memory:' ? mkdtempSync(join(tmpdir(), 'konusgac-')) : dirname(opts.dbPath));
  const store = new Store(openDb(opts.dbPath));
  const access = new Access(store);
  const limits = new RateLimiter(opts.rateLimits === false ? null : { ...DEFAULT_RULES, ...opts.rateLimits });
  const files = new Files(dataDir);
  const gateway = new Gateway(store, access, limits, config, opts.heartbeatInterval);
  const downloads = join(dataDir, 'indir');
  mkdirSync(downloads, { recursive: true });
  // E-mail and Google sign-in need the public address for their links.
  const mailer =
    opts.mailer ?? (config.resendApiKey && config.mailFrom && config.publicUrl ? resendMailer(config.resendApiKey, config.mailFrom) : null);
  const google =
    opts.google ??
    (config.googleClientId && config.googleClientSecret && config.publicUrl ? googleAuth(config.googleClientId, config.googleClientSecret) : null);
  const ctx: Ctx = {
    store,
    access,
    gateway,
    limits,
    files,
    config,
    downloads,
    mailer,
    google,
    isSiteAdmin: (userId) => config.siteAdmins.includes(store.user(userId)?.username.toLowerCase() ?? ''),
    removeMessage: async () => {}, // replaced by routes/channels.ts
    removeGuild: async () => {}, // replaced by routes/guilds.ts
  };

  const trustProxy = opts.trustProxy ?? process.env.TRUST_PROXY === '1';
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024, trustProxy });
  installErrorHandler(app);
  app.decorateRequest('userId', '');

  // Body-less POSTs (typing, invite join) arrive from clients with arbitrary or JSON
  // content types; treat an empty body as absent and ignore non-JSON bodies.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('Geçersiz JSON gövdesi'), { statusCode: 400 }), undefined);
    }
  });
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.maxUploadBytes, files: LIMITS.attachmentsPerMessage, fields: 4, fieldSize: 64 * 1024, parts: 20 },
  });
  app.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined));

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(self), display-capture=(self), geolocation=(), microphone=(self)');
    if (!reply.hasHeader('content-security-policy') && String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
      reply.header('content-security-policy', CSP);
    }
  });

  authRoutes(app, ctx);
  accountRoutes(app, ctx);
  moderationRoutes(app, ctx);
  userRoutes(app, ctx);
  guildRoutes(app, ctx);
  channelRoutes(app, ctx);
  files.routes(app, store);

  // The Windows app is downloaded from the server itself: konusgac.com/indir gives the installer,
  // and installed apps read latest.yml here to update. The deploy script puts the files in place.
  await app.register(fastifyStatic, {
    root: downloads,
    prefix: '/indir/',
    decorateReply: false,
    cacheControl: false,
    setHeaders: (res, path) => res.header('cache-control', path.endsWith('.yml') ? 'no-cache' : 'public, max-age=300'),
  });
  app.get('/indir', (_req, reply) => reply.redirect(`/indir/${INSTALLER}`));

  if (opts.webRoot && existsSync(opts.webRoot)) {
    await app.register(fastifyStatic, {
      root: opts.webRoot,
      // Built files carry a hash in their name: they never change, so browsers keep them (faster
      // starts). The page itself is always checked, so a new version is picked up at once.
      setHeaders: (res, path) =>
        res.header('cache-control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache'),
    });
    // The privacy notice and the terms of use, filled in with who runs this server.
    const legal = (file: string) => async (req: FastifyRequest, reply: FastifyReply) => {
      const site = config.publicUrl ? new URL(config.publicUrl).host : (req.headers.host ?? 'Konuşgaç');
      const fill: Record<string, string> = {
        SITE: site,
        ISLETEN: config.operatorName ?? `${site} yöneticisi`,
        ILETISIM: config.contactEmail ?? '',
      };
      const html = readFileSync(join(opts.webRoot!, file), 'utf8').replace(/\{\{(SITE|ISLETEN|ILETISIM)\}\}/g, (_m, k: string) => escapeHtml(fill[k]!));
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html);
    };
    app.get('/gizlilik', legal('gizlilik.html'));
    app.get('/kosullar', legal('kosullar.html'));
    // Client-side routes fall back to the SPA shell.
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') || req.url.startsWith('/attachments/') || req.url.startsWith('/indir/')
        ? reply.code(404).send({ error: 'Bulunamadı' })
        : reply.sendFile('index.html'),
    );
  }

  gateway.attach(app.server, trustProxy);
  app.addHook('onReady', async () => {
    const removed = await files.sweep(store);
    if (removed) app.log.info(`${removed} sahipsiz ek dosyası silindi`);
  });
  app.addHook('onClose', async () => {
    gateway.close();
    limits.close();
    store.db.close();
  });

  return { app, ...ctx };
}
