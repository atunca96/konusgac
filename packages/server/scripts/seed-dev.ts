// Creates development test accounts and a sample server on a running local Konuşgaç.
// Usage: npm run seed -w @konusgac/server   (server must be listening on BASE_URL)
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001';

export const DEV_ACCOUNTS = [
  { username: 'demo_ayse', password: 'demo-sifre-ayse', displayName: 'Ayşe (demo)' },
  { username: 'demo_baris', password: 'demo-sifre-baris', displayName: 'Barış (demo)' },
];

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

const tokens: string[] = [];
for (const acc of DEV_ACCOUNTS) {
  let res = await call('POST', '/auth/register', undefined, acc);
  if (res.status === 409) res = await call('POST', '/auth/login', undefined, acc);
  if (res.status >= 400) throw new Error(`${acc.username}: ${res.data?.error}`);
  tokens.push(res.data.token);
  console.log(`hesap hazır: ${acc.username}`);
}

const [ayse, baris] = tokens as [string, string];
const guild = await call('POST', '/guilds', ayse, { name: 'Demo Sunucusu' });
const genel = guild.data.channels.find((c: { name: string }) => c.name === 'genel');
const invite = await call('POST', `/channels/${genel.id}/invites`, ayse, {});
const join = await call('POST', `/invites/${invite.data.code}`, baris);
if (join.status >= 400) throw new Error(`davet: ${join.data?.error}`);
await call('POST', `/channels/${genel.id}/messages`, ayse, { content: 'Konuşgaç’a hoş geldiniz! **Kalın**, *italik* ve `kod` desteklenir.' });
await call('POST', `/channels/${genel.id}/messages`, baris, { content: 'Selam Ayşe, her şey çalışıyor gibi 👋' });
console.log('"Demo Sunucusu" oluşturuldu, iki hesap da üye.');
