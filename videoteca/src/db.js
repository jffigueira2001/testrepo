import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

for (const dir of [config.dataDir, config.uploadsDir, config.videosDir, config.thumbsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new DatabaseSync(config.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS teams (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id          INTEGER PRIMARY KEY,
    team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,              -- YYYY-MM-DD
    opponent    TEXT NOT NULL,
    competition TEXT NOT NULL DEFAULT '',
    venue       TEXT NOT NULL DEFAULT 'casa' CHECK (venue IN ('casa', 'fora', 'neutro')),
    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS games_team_date ON games(team_id, date DESC);

  CREATE TABLE IF NOT EXISTS videos (
    id            INTEGER PRIMARY KEY,
    game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    parent_id     INTEGER REFERENCES videos(id) ON DELETE SET NULL,
    title         TEXT NOT NULL,
    original_name TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'error')),
    source_path   TEXT,                     -- ficheiro bruto do upload (até ser processado)
    file          TEXT,                     -- mp4 final, relativo a videosDir
    thumb         TEXT,                     -- jpg, relativo a thumbsDir
    size          INTEGER NOT NULL DEFAULT 0,
    duration      REAL NOT NULL DEFAULT 0,
    width         INTEGER NOT NULL DEFAULT 0,
    height        INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS videos_game ON videos(game_id);

  CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY,
    video_id    INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,              -- ingest | trim | rotate | mute | compress
    params      TEXT NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'error')),
    progress    REAL NOT NULL DEFAULT 0,
    error       TEXT,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
`);

// Migração: contas pedidas pelo site ficam 'pending' até um admin aprovar.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'status')) {
  db.exec(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending'))`);
}

/** Executa fn dentro de uma transação. */
export function tx(fn) {
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
