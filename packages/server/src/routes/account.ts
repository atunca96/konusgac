import { LIMITS } from '@konusgac/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashPassword, newToken, verifyPassword } from '../auth';
import { HttpError, requireAuth, type Ctx } from '../http';
import { resetMail, verifyMail } from '../mail';
import { clientIp } from '../ratelimit';
import { password } from './auth';

// E-mail (verification, "Şifremi unuttum") and "Google ile devam et".
//
// Links in e-mails carry a single-use token (?dogrula=… or ?sifirla=… on the site). Google sign-in
// ends with a single-use code (?giris=… on the site, or konusgac://giris?kod=… for the desktop
// app, which signs in through the system browser because Google refuses embedded ones); the code
// is traded for a normal session.

export const email = z.email('geçerli bir e-posta adresi yaz').trim().toLowerCase().max(254);
const token = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, 'geçersiz bağlantı');

const VERIFY_TTL = 24 * 60 * 60_000;
const RESET_TTL = 60 * 60_000;
const LOGIN_CODE_TTL = 2 * 60_000;
const STATE_TTL = 10 * 60_000;

export function accountRoutes(app: FastifyInstance, ctx: Ctx) {
  const { store, limits, config, mailer, google } = ctx;
  const auth = { preHandler: requireAuth(store, limits) };
  const link = (query: string) => `${config.publicUrl}/?${query}`;

  // Sends the verification link for an address; the address is confirmed only when it is clicked.
  async function sendVerification(userId: string, address: string) {
    if (!mailer) throw new HttpError(400, 'Bu sunucu e-posta gönderemiyor');
    limits.check('mail', address);
    const t = store.createOneTimeToken('verifyEmail', userId, VERIFY_TTL, address);
    await deliver(() => mailer(verifyMail(address, store.user(userId)!.displayName, link(`dogrula=${t}`))));
  }

  async function deliver(send: () => Promise<void>) {
    try {
      await send();
    } catch (err) {
      app.log.error({ err }, 'E-posta gönderilemedi');
      throw new HttpError(502, 'E-posta şu an gönderilemedi, biraz sonra tekrar dene');
    }
  }

  // Exposed to registration (routes/auth.ts) too.
  ctx.sendVerification = sendVerification;

  // ---------- the account's own e-mail ----------

  app.get('/api/users/@me/account', auth, async (req) => ({ ...store.account(req.userId), siteAdmin: ctx.isSiteAdmin(req.userId) }));

  // New address: it must be confirmed again. The password is asked when the account has one.
  app.put('/api/users/@me/email', auth, async (req) => {
    const body = z.object({ email, password: z.string().max(LIMITS.passwordMax).optional() }).parse(req.body);
    const account = store.account(req.userId);
    if (account.hasPassword) {
      limits.check('password', req.userId);
      if (!(await verifyPassword(body.password ?? '', store.passwordHashById(req.userId) ?? ''))) throw new HttpError(403, 'Mevcut şifre yanlış');
    }
    const owner = store.userIdByEmail(body.email);
    if (owner && owner !== req.userId) throw new HttpError(409, 'Bu e-posta başka bir hesapta kullanılıyor');
    store.setEmail(req.userId, body.email, false);
    if (mailer) await sendVerification(req.userId, body.email);
    return store.account(req.userId);
  });

  app.post('/api/users/@me/email/verify', auth, async (req, reply) => {
    const { email: address, emailVerified } = store.account(req.userId);
    if (!address) throw new HttpError(400, 'Hesabında e-posta yok');
    if (emailVerified) throw new HttpError(400, 'E-postan zaten doğrulanmış');
    await sendVerification(req.userId, address);
    return reply.code(204).send();
  });

  app.post('/api/auth/email/verify', async (req) => {
    limits.check('emailToken', clientIp(req));
    const used = store.consumeOneTimeToken('verifyEmail', z.object({ token }).parse(req.body).token);
    // The link confirms the address it was sent to, not one changed afterwards.
    if (!used || !used.email || store.account(used.userId).email !== used.email) {
      throw new HttpError(400, 'Bu doğrulama bağlantısı geçersiz ya da süresi dolmuş');
    }
    store.setEmail(used.userId, used.email, true);
    return { email: used.email };
  });

  // ---------- "Şifremi unuttum" ----------

  // Always answers the same, so nobody can find out which addresses have an account.
  app.post('/api/auth/password/forgot', async (req, reply) => {
    if (!mailer) throw new HttpError(400, 'Bu sunucu e-posta gönderemiyor');
    const body = z.object({ email }).parse(req.body);
    limits.check('mail', clientIp(req));
    const userId = store.userIdByEmail(body.email);
    if (userId && limits.take('mail', body.email) === 0) {
      const user = store.user(userId)!;
      const t = store.createOneTimeToken('resetPassword', userId, RESET_TTL);
      void mailer(resetMail(body.email, user.displayName, user.username, link(`sifirla=${t}`))).catch((err) =>
        app.log.error({ err }, 'Şifre sıfırlama e-postası gönderilemedi'),
      );
    }
    return reply.code(204).send();
  });

  app.post('/api/auth/password/reset', async (req, reply) => {
    limits.check('emailToken', clientIp(req));
    const body = z.object({ token, password }).parse(req.body);
    const used = store.consumeOneTimeToken('resetPassword', body.token);
    if (!used) throw new HttpError(400, 'Bu sıfırlama bağlantısı geçersiz ya da süresi dolmuş');
    store.resetPassword(used.userId, await hashPassword(body.password));
    // Whoever could open the link also controls the mailbox: the address is confirmed.
    const { email: address } = store.account(used.userId);
    if (address) store.setEmail(used.userId, address, true);
    ctx.gateway.disconnectUser(used.userId);
    return reply.code(204).send();
  });

  // ---------- "Google ile devam et" ----------

  const states = new Map<string, { app: boolean; expires: number }>();
  const redirectUri = () => `${config.publicUrl}/api/auth/google/callback`;

  app.get('/api/auth/google', async (req, reply) => {
    if (!google) throw new HttpError(404, 'Bu sunucuda Google ile giriş yok');
    const now = Date.now();
    for (const [k, v] of states) if (v.expires < now) states.delete(k);
    const state = randomBytes(24).toString('base64url');
    states.set(state, { app: (req.query as { app?: string }).app === '1', expires: now + STATE_TTL });
    return reply.redirect(google.authorizeUrl(state, redirectUri()));
  });

  app.get('/api/auth/google/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const pending = q.state ? states.get(q.state) : undefined;
    if (q.state) states.delete(q.state);
    const done = (result: { code: string } | { error: string }) => finishGoogle(reply, pending?.app ?? false, result);
    if (!google || !pending || pending.expires < Date.now()) return done({ error: 'Giriş isteğinin süresi doldu, tekrar dene' });
    if (q.error || !q.code) return done({ error: 'Google ile giriş iptal edildi' });

    let identity;
    try {
      identity = await google.exchange(q.code, redirectUri());
    } catch (err) {
      app.log.error({ err }, 'Google girişi başarısız');
      return done({ error: 'Google ile giriş şu an yapılamadı' });
    }

    let userId = store.userIdByGoogle(identity.sub);
    if (!userId && identity.email && identity.emailVerified) {
      // An account with the same address: linked only if that address was confirmed there too,
      // so nobody can take over an account by typing someone else's e-mail into it.
      const existing = store.userIdByEmail(identity.email);
      if (existing) {
        if (!store.account(existing).emailVerified) {
          return done({ error: 'Bu e-posta başka bir hesapta kayıtlı ama doğrulanmamış. O hesapla giriş yapıp e-postanı doğrula, sonra Google ile girebilirsin.' });
        }
        store.linkGoogle(existing, identity.sub);
        userId = existing;
      }
    }
    if (!userId) {
      if (config.registration === 'closed') return done({ error: 'Bu sunucu yeni hesap kabul etmiyor' });
      const name = (identity.name ?? identity.email?.split('@')[0] ?? 'kullanici').trim().slice(0, LIMITS.displayNameMax);
      const user = store.createUser({
        username: freeUsername(identity.email?.split('@')[0] ?? identity.name ?? 'kullanici'),
        displayName: name || 'Kullanıcı',
        passwordHash: await hashPassword(randomBytes(32).toString('base64url')), // unusable until one is set
        hasPassword: false,
        email: identity.email && identity.emailVerified && !store.userIdByEmail(identity.email) ? identity.email : null,
        emailVerified: identity.emailVerified,
        googleSub: identity.sub,
      });
      userId = user.id;
    }
    if (store.isBanned(userId)) return done({ error: 'Bu hesap kurallara aykırılık nedeniyle kapatıldı' });
    return done({ code: store.createOneTimeToken('login', userId, LOGIN_CODE_TTL) });
  });

  app.post('/api/auth/google/exchange', async (req) => {
    limits.check('emailToken', clientIp(req));
    const used = store.consumeOneTimeToken('login', z.object({ code: token }).parse(req.body).code);
    if (!used) throw new HttpError(400, 'Giriş kodu geçersiz ya da süresi dolmuş, tekrar dene');
    const session = newToken();
    store.createSession(used.userId, session.hash, req.headers['user-agent'] ?? '');
    return { token: session.token, user: store.user(used.userId)! };
  });

  // A user name nobody has, from an e-mail's first part: "Ayşe.Kaya" → "ayse.kaya", "ayse.kaya2"…
  function freeUsername(seed: string): string {
    const base =
      seed
        .toLocaleLowerCase('tr')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/ı/g, 'i')
        .replace(/[^a-z0-9_.]/g, '')
        .slice(0, LIMITS.usernameMax - 4) || 'kullanici';
    const padded = base.length >= LIMITS.usernameMin ? base : `${base}_kg`.slice(0, Math.max(LIMITS.usernameMin, base.length + 3));
    if (!store.userByUsername(padded)) return padded;
    for (let i = 2; ; i++) {
      const name = `${padded}${i}`.slice(-LIMITS.usernameMax);
      if (!store.userByUsername(name)) return name;
    }
  }
}

// After Google: the web app gets ?giris=<code> (or ?giris_hata=…); the desktop app, which signed in
// through the system browser, gets a page that hands the code back to it via konusgac://.
function finishGoogle(reply: FastifyReply, desktop: boolean, result: { code: string } | { error: string }) {
  if (!desktop) {
    const q = 'code' in result ? `giris=${result.code}` : `giris_hata=${encodeURIComponent(result.error)}`;
    return reply.redirect(`/?${q}`);
  }
  const deep = 'code' in result ? `konusgac://giris?kod=${result.code}` : null;
  const message = 'code' in result ? 'Giriş tamam. Konuşgaç uygulamasına dönülüyor…' : result.error;
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Konuşgaç</title>
${deep ? `<meta http-equiv="refresh" content="0;url=${deep}">` : ''}
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15171c;color:#e9eaec;font-family:Segoe UI,system-ui,sans-serif}
div{background:#23262e;border-radius:14px;padding:32px;max-width:420px;text-align:center}a{display:inline-block;margin-top:16px;background:#e8590c;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600}</style>
</head><body><div><h2>Konuşgaç</h2><p>${message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p>
${deep ? `<a href="${deep}">Uygulamayı aç</a><p style="color:#9aa0ab;font-size:13px">Uygulama açılmazsa düğmeye bas. Bu sekmeyi kapatabilirsin.</p>` : ''}
</div></body></html>`;
  return reply.type('text/html; charset=utf-8').send(html);
}
