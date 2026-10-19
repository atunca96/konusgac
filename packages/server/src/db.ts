import { searchText } from '@konusgac/shared';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guilds (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  icon_color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL,
  permissions INTEGER NOT NULL,
  position    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  guild_id  TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nick      TEXT,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS member_roles (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  role_id  TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, user_id, role_id),
  FOREIGN KEY (guild_id, user_id) REFERENCES members(guild_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channels (
  id              TEXT PRIMARY KEY,
  guild_id        TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  name            TEXT NOT NULL,
  parent_id       TEXT,
  position        INTEGER NOT NULL,
  topic           TEXT NOT NULL DEFAULT '',
  overwrites      TEXT NOT NULL DEFAULT '[]',
  last_message_id TEXT
);
CREATE INDEX IF NOT EXISTS channels_guild ON channels(guild_id);

CREATE TABLE IF NOT EXISTS dm_recipients (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS dm_recipients_user ON dm_recipients(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at  INTEGER
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);

CREATE TABLE IF NOT EXISTS relationships (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type     TEXT NOT NULL,
  PRIMARY KEY (user_id, other_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  uses       INTEGER NOT NULL DEFAULT 0,
  max_uses   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_key     TEXT NOT NULL UNIQUE, -- random path segment; the file lives at <dataDir>/attachments/<file_key>
  filename     TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  position     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, emoji, user_id)
);

CREATE TABLE IF NOT EXISTS read_states (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_id  TEXT,
  mention_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Incremental upgrades for databases created by older versions, tracked in user_version.
function migrate(db: Db) {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version < 1) {
    // v0.2 voice channels: existing @everyone roles get Connect (1 << 10) and Speak (1 << 11).
    db.exec(`UPDATE roles SET permissions = permissions | ${(1 << 10) | (1 << 11)} WHERE id = guild_id`);
  }
  if (version < 2) {
    // v0.3 replies, mentions and search; @everyone gets AttachFiles (1 << 12) and AddReactions (1 << 13).
    transaction(db, () => {
      db.exec(`
        ALTER TABLE messages ADD COLUMN reply_to_id TEXT;
        ALTER TABLE messages ADD COLUMN mention_ids TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE messages ADD COLUMN mention_everyone INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE messages ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
        UPDATE roles SET permissions = permissions | ${(1 << 12) | (1 << 13)} WHERE id = guild_id;
      `);
      const update = db.prepare('UPDATE messages SET search_text = ? WHERE id = ?');
      for (const r of db.prepare('SELECT id, content FROM messages').all() as { id: string; content: string }[]) {
        update.run(searchText(r.content), r.id);
      }
    });
  }
  if (version < 3) {
    // v0.4 privacy settings and devices.
    db.exec(`
      ALTER TABLE users ADD COLUMN dm_from_members INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE users ADD COLUMN friend_requests TEXT NOT NULL DEFAULT '{"everyone":true,"friendsOfFriends":true,"serverMembers":true}';
      ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
      ALTER TABLE sessions ADD COLUMN last_used INTEGER NOT NULL DEFAULT 0;
      UPDATE sessions SET last_used = created_at;
    `);
  }
  if (version < 4) {
    // v0.5 camera and screen sharing: @everyone gets Stream (1 << 15).
    db.exec(`UPDATE roles SET permissions = permissions | ${1 << 15} WHERE id = guild_id`);
  }
  if (version < 5) {
    // v0.7 e-mail (verification, password reset) and Google sign-in. has_password is 0 for accounts
    // made with Google until they set one. one_time_tokens holds e-mail links and sign-in codes,
    // hashed like sessions.
    db.exec(`
      ALTER TABLE users ADD COLUMN email TEXT;
      ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN google_sub TEXT;
      ALTER TABLE users ADD COLUMN has_password INTEGER NOT NULL DEFAULT 1;
      CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email) WHERE email IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS users_google ON users(google_sub) WHERE google_sub IS NOT NULL;
      CREATE TABLE IF NOT EXISTS one_time_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        email      TEXT,
        expires_at INTEGER NOT NULL
      );
    `);
  }
  if (version < 6) {
    // v0.9 when the account accepted the terms of use and the privacy notice.
    db.exec('ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER');
  }
  if (version < 7) {
    // v0.9 moderation: platform bans, server bans, reports (with a copy of the reported message).
    db.exec(`
      ALTER TABLE users ADD COLUMN banned_at INTEGER;
      ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT '';
      CREATE TABLE IF NOT EXISTS guild_bans (
        guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason     TEXT NOT NULL DEFAULT '',
        banned_by  TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id          TEXT PRIMARY KEY,
        reporter_id TEXT,
        message_id  TEXT,
        channel_id  TEXT NOT NULL,
        guild_id    TEXT,
        author_id   TEXT,
        reason      TEXT NOT NULL,
        note        TEXT NOT NULL DEFAULT '',
        content     TEXT NOT NULL DEFAULT '',
        attachments TEXT NOT NULL DEFAULT '[]',
        status      TEXT NOT NULL DEFAULT 'open',
        created_at  INTEGER NOT NULL,
        resolved_by TEXT,
        resolved_at INTEGER
      );
    `);
  }
  db.exec('PRAGMA user_version = 7');
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
