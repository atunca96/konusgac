import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './store';

// Attachment files live on disk at <dataDir>/attachments/<fileKey>. The key is 128 random
// bits, so the URL itself is the permission to read the file (like a private link): images
// can be shown with a plain <img> tag without sending the session token.

const KEY = /^[A-Za-z0-9_-]{22}$/;

// Types shown inline in the app. The type comes from the file's first bytes, never from the
// uploader, and everything else is served as a download so no upload can run as a page.
const INLINE_TYPES: { type: string; test: (b: Buffer) => boolean }[] = [
  { type: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  { type: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { type: 'video/mp4', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' },
  { type: 'video/webm', test: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  { type: 'audio/mpeg', test: (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) },
  { type: 'audio/ogg', test: (b) => b.subarray(0, 4).toString('latin1') === 'OggS' },
];

export function sniffType(head: Buffer): string {
  return INLINE_TYPES.find((t) => t.test(head))?.type ?? 'application/octet-stream';
}

// Keeps a readable name: no path parts, no control characters, at most 100 characters.
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim().slice(-100);
  return clean && clean !== '.' && clean !== '..' ? clean : 'dosya';
}

export class Files {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'attachments');
  }

  async save(data: Buffer): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const key = randomBytes(16).toString('base64url');
    await writeFile(join(this.dir, key), data, { flag: 'wx' });
    return key;
  }

  async remove(keys: Iterable<string>) {
    for (const key of keys) if (KEY.test(key)) await rm(join(this.dir, key), { force: true });
  }

  // Deletes files no message refers to any more, e.g. after a channel or server was deleted.
  async sweep(store: Store): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    const known = store.allFileKeys();
    const orphans = names.filter((n) => !known.has(n));
    await this.remove(orphans);
    return orphans.length;
  }

  routes(app: FastifyInstance, store: Store) {
    app.get('/attachments/:key/:name', async (req, reply) => {
      const { key } = req.params as { key: string; name: string };
      const row = KEY.test(key)
        ? (store.db.prepare('SELECT filename, content_type FROM attachments WHERE file_key = ?').get(key) as
            | { filename: string; content_type: string }
            | undefined)
        : undefined;
      const path = join(this.dir, key);
      const info = row && (await stat(path).catch(() => undefined));
      if (!row || !info) return reply.code(404).send({ error: 'Dosya bulunamadı' });

      const inline = row.content_type !== 'application/octet-stream';
      const encoded = encodeURIComponent(row.filename);
      reply
        .header('content-type', row.content_type)
        .header('content-length', info.size)
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`)
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, max-age=31536000, immutable');
      return reply.send(createReadStream(path));
    });
  }
}
