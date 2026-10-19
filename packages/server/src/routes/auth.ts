import { LIMITS } from '@konusgac/shared';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { hashPassword, hashToken, newToken, verifyPassword } from '../auth';
import { HttpError, INSTALLER, requireAuth, type Ctx } from '../http';
import { clientIp } from '../ratelimit';

const username = z
  .string()
  .trim()
  .min(LIMITS.usernameMin, `en az ${LIMITS.usernameMin} karakter`)
  .max(LIMITS.usernameMax, `en fazla ${LIMITS.usernameMax} karakter`)
  .regex(/^[a-zA-Z0-9_.]+$/, 'yalnızca harf, rakam, _ ve . kullanılabilir');

export const password = z
  .string()
  .min(LIMITS.passwordMin, `en az ${LIMITS.passwordMin} karakter`)
  .max(LIMITS.passwordMax, `en fazla ${LIMITS.passwordMax} karakter`);

const registerBody = z.object({
  username,
  password,
  displayName: z.string().trim().max(LIMITS.displayNameMax).optional(),
  email: z.email('geçerli bir e-posta adresi yaz').trim().toLowerCase().max(254).optional(),
  // The sign-up form's "Kullanım Koşulları'nı ve Gizlilik Politikası'nı okudum, kabul ediyorum" box.
  acceptTerms: z.literal(true, 'Devam etmek için Kullanım Koşulları ve Gizlilik Politikası kabul edilmeli'),
});

// "username" is the user name or the e-mail address.
const loginBody = z.object({ username: z.string().trim().max(254), password: z.string().max(LIMITS.passwordMax) });

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const { store, limits, config, downloads } = ctx;
  // Public server information the sign-in screen needs.
  app.get('/api/config', async () => ({
    registration: config.registration,
    desktopApp: existsSync(join(downloads, INSTALLER)), // the Windows app can be downloaded at /indir
    mail: !!ctx.mailer, // sign-up asks for an e-mail; "Şifremi unuttum" works
    google: !!ctx.google, // "Google ile devam et"
  }));

  app.post('/api/auth/register', async (req, reply) => {
    if (config.registration === 'closed') throw new HttpError(403, 'Bu sunucu yeni hesap kabul etmiyor');
    limits.check('register', clientIp(req));
    const body = registerBody.parse(req.body);
    // With e-mail on, an address is required: it is how a forgotten password comes back.
    if (ctx.mailer && !body.email) throw new HttpError(400, 'E-posta adresi gerekli');
    if (store.userByUsername(body.username)) throw new HttpError(409, 'Bu kullanıcı adı alınmış');
    if (body.email && store.userIdByEmail(body.email)) throw new HttpError(409, 'Bu e-posta ile zaten bir hesap var');
    const user = store.createUser({
      username: body.username,
      displayName: body.displayName || body.username,
      passwordHash: await hashPassword(body.password),
      email: body.email ?? null,
    });
    const { token, hash } = newToken();
    store.createSession(user.id, hash, req.headers['user-agent'] ?? '');
    // The account works at once; the address is confirmed when the link in the mail is clicked.
    if (body.email && ctx.sendVerification) await ctx.sendVerification(user.id, body.email).catch(() => {});
    return reply.code(201).send({ token, user });
  });

  app.post('/api/auth/login', async (req) => {
    const body = loginBody.parse(req.body);
    // Guessing is slowed per IP+account and per IP, so neither one account nor many can be brute-forced.
    limits.check('loginIp', clientIp(req));
    limits.check('login', `${clientIp(req)}|${body.username.toLowerCase()}`);
    const record = store.passwordHash(body.username);
    // Verify against a dummy hash for unknown users to keep timing uniform.
    const ok = await verifyPassword(body.password, record?.hash ?? DUMMY_HASH);
    if (!record || !ok) throw new HttpError(401, 'Kullanıcı adı, e-posta ya da şifre hatalı');
    if (store.isBanned(record.userId)) throw new HttpError(403, 'Bu hesap kurallara aykırılık nedeniyle kapatıldı');
    const { token, hash } = newToken();
    store.createSession(record.userId, hash, req.headers['user-agent'] ?? '');
    return { token, user: store.user(record.userId)! };
  });

  app.post('/api/auth/logout', { preHandler: requireAuth(store, limits), config: { limit: 'none' } }, async (req, reply) => {
    const token = (req.headers.authorization ?? '').slice(7);
    store.deleteSession(hashToken(token));
    return reply.code(204).send();
  });
}

export const DUMMY_HASH = await hashPassword('konusgac-dummy-password');
