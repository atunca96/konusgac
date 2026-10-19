import { useSyncExternalStore } from 'react';
import { api, setToken } from './api';

// Links that open the site with something to do, from e-mails and from Google sign-in:
//   ?giris=<code>         Google sign-in finished: trade the code for a session
//   ?giris_hata=<message> Google sign-in failed
//   ?dogrula=<token>      e-mail verification link
//   ?sifirla=<token>      password reset link: show the "new password" form
// They are read once at start and removed from the address bar.

export interface Notice {
  kind: 'success' | 'error';
  text: string;
}

let notice: Notice | null = null;
let resetToken: string | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function showNotice(n: Notice | null) {
  notice = n;
  changed();
}

export const useNotice = () => useSyncExternalStore(subscribe, () => notice);
export const useResetToken = () => useSyncExternalStore(subscribe, () => resetToken);

export function finishReset() {
  resetToken = null;
  changed();
}

export async function handleLinks(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const keys = ['giris', 'giris_hata', 'dogrula', 'sifirla'];
  if (!keys.some((k) => q.has(k))) return;
  history.replaceState(null, '', location.pathname + location.hash);

  const fail = (e: unknown) => showNotice({ kind: 'error', text: (e as Error).message });
  if (q.get('giris_hata')) showNotice({ kind: 'error', text: q.get('giris_hata')! });
  const code = q.get('giris');
  if (code) await api.googleExchange(code).then((r) => setToken(r.token), fail);
  const verify = q.get('dogrula');
  if (verify) {
    await api.verifyEmail(verify).then((r) => showNotice({ kind: 'success', text: `E-posta adresin doğrulandı: ${r.email}` }), fail);
  }
  const reset = q.get('sifirla');
  if (reset) {
    resetToken = reset;
    changed();
  }
}
