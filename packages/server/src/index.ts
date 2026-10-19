import { fileURLToPath } from 'node:url';
import { createApp } from './app';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';
const dbPath = process.env.KONUSGAC_DB ?? fileURLToPath(new URL('../../../data/konusgac.db', import.meta.url));
const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));

const { app, gateway } = await createApp({ dbPath, webRoot, logger: true });
await app.listen({ port, host });
await gateway.sfu.start().then(
  () => app.log.info('Ses sunucusu hazır'),
  (err) => app.log.error({ err }, 'Ses sunucusu başlatılamadı; sesli kanallar çalışmayacak'),
);
