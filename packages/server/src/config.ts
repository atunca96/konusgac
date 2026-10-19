// Settings a server operator can change with environment variables.
export interface ServerConfig {
  registration: 'open' | 'closed'; // closed: no new accounts (existing users keep working)
  maxUploadBytes: number; // per file
  // Voice and video: the one port (UDP and TCP) the media server listens on, and the address
  // clients reach it at (an IP or a host name; null = this machine's own address).
  rtcPort: number;
  rtcAddress: string | null;
  // The address people open (https://konusgac.com): links in e-mails and the Google return address.
  publicUrl: string | null;
  // E-mail through Resend; without a key there is no e-mail.
  resendApiKey: string | null;
  mailFrom: string | null; // e.g. "Konuşgaç <noreply@konusgac.com>"; the domain must be verified in Resend
  // "Google ile devam et"; both from Google Cloud Console → Credentials → OAuth client ID.
  googleClientId: string | null;
  googleClientSecret: string | null;
  // Who runs this server, for the terms of use and the privacy notice (/kosullar, /gizlilik).
  operatorName: string | null;
  contactEmail: string | null;
  // The platform's operators (user names): reports, removing any content, platform bans.
  siteAdmins: string[];
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    registration: env.KONUSGAC_REGISTRATION === 'closed' ? 'closed' : 'open',
    maxUploadBytes: Math.max(1, Number(env.KONUSGAC_MAX_UPLOAD_MB) || 10) * 1024 * 1024,
    rtcPort: env.KONUSGAC_RTC_PORT ? Number(env.KONUSGAC_RTC_PORT) : 40000,
    rtcAddress: env.KONUSGAC_RTC_ADDRESS || null,
    publicUrl: (env.KONUSGAC_PUBLIC_URL || (env.KONUSGAC_ALAN_ADI ? `https://${env.KONUSGAC_ALAN_ADI}` : '')).replace(/\/+$/, '') || null,
    resendApiKey: env.RESEND_API_KEY || null,
    mailFrom: env.KONUSGAC_MAIL_FROM || (env.KONUSGAC_ALAN_ADI ? `Konuşgaç <noreply@${env.KONUSGAC_ALAN_ADI}>` : null),
    googleClientId: env.GOOGLE_CLIENT_ID || null,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || null,
    operatorName: env.KONUSGAC_ISLETEN || null,
    contactEmail: env.KONUSGAC_ILETISIM || null,
    siteAdmins: (env.KONUSGAC_YONETICILER ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}
