import type { FastifyRequest } from 'fastify';
import { HttpError } from './http';

// Token buckets kept in memory: each key may spend `limit` actions per `windowMs`,
// refilled continuously. Enough for one server process; nothing to configure.
export interface Rule {
  limit: number;
  windowMs: number;
}

export const DEFAULT_RULES = {
  register: { limit: 5, windowMs: 60 * 60_000 }, // per IP
  login: { limit: 10, windowMs: 15 * 60_000 }, // per IP + username
  loginIp: { limit: 30, windowMs: 15 * 60_000 }, // per IP, across usernames
  message: { limit: 10, windowMs: 10_000 }, // per user
  upload: { limit: 20, windowMs: 60_000 }, // per user, counted per file
  reaction: { limit: 20, windowMs: 10_000 }, // per user
  typing: { limit: 6, windowMs: 10_000 }, // per user
  write: { limit: 60, windowMs: 60_000 }, // per user, every other change (guilds, channels, roles, friends...)
  search: { limit: 20, windowMs: 60_000 }, // per user
  password: { limit: 5, windowMs: 15 * 60_000 }, // per user: password change / account deletion attempts
  mail: { limit: 5, windowMs: 60 * 60_000 }, // e-mails asked for, per IP and per address
  report: { limit: 10, windowMs: 60 * 60_000 }, // reports per user
  emailToken: { limit: 20, windowMs: 15 * 60_000 }, // e-mail links and sign-in codes tried, per IP
  gatewayFrames: { limit: 120, windowMs: 60_000 }, // per connection
  rtcRequests: { limit: 900, windowMs: 60_000 }, // voice-server requests per connection
  gatewayConnections: { limit: 20, windowMs: 60_000 }, // new connections per IP
} satisfies Record<string, Rule>;

export type RuleName = keyof typeof DEFAULT_RULES;
export type Rules = Record<RuleName, Rule>;

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private sweeper: NodeJS.Timeout;

  constructor(readonly rules: Rules | null) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  // Spends `cost` tokens; returns the milliseconds to wait if the bucket is empty, else 0.
  take(rule: RuleName, key: string, cost = 1): number {
    if (!this.rules) return 0;
    const { limit, windowMs } = this.rules[rule];
    const id = `${rule}:${key}`;
    const now = Date.now();
    const b = this.buckets.get(id) ?? { tokens: limit, at: now };
    b.tokens = Math.min(limit, b.tokens + ((now - b.at) * limit) / windowMs);
    b.at = now;
    this.buckets.set(id, b);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return 0;
    }
    return Math.ceil(((cost - b.tokens) * windowMs) / limit);
  }

  // Throws 429 with Retry-After when the bucket is empty.
  check(rule: RuleName, key: string, cost = 1) {
    const wait = this.take(rule, key, cost);
    if (wait > 0) throw new RateLimited(wait);
  }

  close() {
    clearInterval(this.sweeper);
  }

  private sweep() {
    const now = Date.now();
    for (const [id, b] of this.buckets) {
      const rule = this.rules?.[id.slice(0, id.indexOf(':')) as RuleName];
      if (!rule || now - b.at > rule.windowMs) this.buckets.delete(id);
    }
  }
}

export class RateLimited extends HttpError {
  constructor(readonly retryAfterMs: number) {
    super(429, `Çok hızlı gidiyorsun; ${Math.max(1, Math.ceil(retryAfterMs / 1000))} saniye sonra tekrar dene.`);
  }
}

export const clientIp = (req: FastifyRequest) => req.ip;
