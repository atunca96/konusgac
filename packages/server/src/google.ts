// "Google ile devam et": the OAuth 2.0 authorization-code flow (OpenID Connect).
// The browser goes to Google, comes back to /api/auth/google/callback with a code, and the server
// trades that code for the person's Google identity directly with Google over HTTPS. Because the
// ID token comes straight from Google's token endpoint, its signature need not be checked again
// (OpenID Connect Core 3.1.3.7); its audience and issuer still are.

export interface GoogleIdentity {
  sub: string; // Google's stable account ID
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export interface GoogleAuth {
  authorizeUrl(state: string, redirectUri: string): string;
  exchange(code: string, redirectUri: string): Promise<GoogleIdentity>;
}

export function googleAuth(clientId: string, clientSecret: string): GoogleAuth {
  return {
    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    },

    async exchange(code, redirectUri) {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const { id_token: idToken } = (await res.json()) as { id_token?: string };
      const payload = JSON.parse(Buffer.from((idToken ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
      const iss = payload.iss;
      if (payload.aud !== clientId || (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') || typeof payload.sub !== 'string') {
        throw new Error('Google kimliği doğrulanamadı');
      }
      return {
        sub: payload.sub,
        email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
        emailVerified: payload.email_verified === true,
        name: typeof payload.name === 'string' ? payload.name : null,
      };
    },
  };
}
