'use strict';

const path = require('path');
const os = require('os');
const BetterSqlite3 = require('better-sqlite3');
const logger = require('../utils/logger');
const migrations = require('./migrations');

const DB_PATH = path.join(
  process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
  'nexus.db'
);

let db = null;

/**
 * Open (or create) the SQLite database with WAL mode and sensible PRAGMA settings.
 * Returns the singleton db instance.
 */
function openDatabase() {
  if (db) return db;

  const fs = require('fs');
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new BetterSqlite3(DB_PATH, { verbose: null });

  // Performance & reliability
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000');   // 32 MB
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456'); // 256 MB
  db.pragma('foreign_keys = ON');
  db.pragma('wal_autocheckpoint = 1000');

  createSchema(db);
  migrations.run(db);

  logger.info('Database opened', { path: DB_PATH });
  return db;
}

/**
 * Build the base schema on first run. Migrations handle subsequent changes.
 */
function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER NOT NULL,
      applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id            TEXT    PRIMARY KEY,
      url           TEXT    NOT NULL,
      title         TEXT    NOT NULL DEFAULT '',
      filename      TEXT    NOT NULL DEFAULT '',
      save_path     TEXT    NOT NULL DEFAULT '',
      category      TEXT    NOT NULL DEFAULT 'other',
      status        TEXT    NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','queued','downloading','paused',
                                             'merging','completed','error','cancelled')),
      file_size     INTEGER NOT NULL DEFAULT 0,
      downloaded    INTEGER NOT NULL DEFAULT 0,
      speed         REAL    NOT NULL DEFAULT 0,
      progress      REAL    NOT NULL DEFAULT 0,
      error_msg     TEXT,
      mime_type     TEXT,
      referrer      TEXT,
      headers       TEXT    NOT NULL DEFAULT '{}',
      chunks        TEXT    NOT NULL DEFAULT '[]',
      is_hls        INTEGER NOT NULL DEFAULT 0,
      is_dash       INTEGER NOT NULL DEFAULT 0,
      is_playlist   INTEGER NOT NULL DEFAULT 0,
      playlist_id   TEXT,
      eta           INTEGER NOT NULL DEFAULT 0,
      retries       INTEGER NOT NULL DEFAULT 0,
      max_retries   INTEGER NOT NULL DEFAULT 3,
      priority      INTEGER NOT NULL DEFAULT 5,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      started_at    TEXT,
      finished_at   TEXT,
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id          TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT '',
      total       INTEGER NOT NULL DEFAULT 0,
      completed   INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','downloading','completed','error')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS download_chunks (
      id           TEXT    PRIMARY KEY,
      download_id  TEXT    NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
      chunk_index  INTEGER NOT NULL,
      start_byte   INTEGER NOT NULL,
      end_byte     INTEGER NOT NULL,
      downloaded   INTEGER NOT NULL DEFAULT 0,
      status       TEXT    NOT NULL DEFAULT 'pending'
                           CHECK(status IN ('pending','downloading','completed','error')),
      temp_file    TEXT,
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(download_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stats (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      date          TEXT    NOT NULL,
      downloaded    INTEGER NOT NULL DEFAULT 0,
      upload        INTEGER NOT NULL DEFAULT 0,
      count         INTEGER NOT NULL DEFAULT 0,
      UNIQUE(date)
    );

    CREATE INDEX IF NOT EXISTS idx_downloads_status    ON downloads(status);
    CREATE INDEX IF NOT EXISTS idx_downloads_created   ON downloads(created_at);
    CREATE INDEX IF NOT EXISTS idx_downloads_playlist  ON downloads(playlist_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_download_id  ON download_chunks(download_id);
  `);
}

/**
 * Close the database connection gracefully.
 */
function closeDatabase() {
  if (db) {
    try {
      db.close();
      logger.info('Database closed');
    } catch (err) {
      logger.error('Error closing database', { err: err.message });
    }
    db = null;
  }
}

/**
 * Return the open database instance (throws if not opened yet).
 */
function getDb() {
  if (!db) throw new Error('Database not opened. Call openDatabase() first.');
  return db;
}

module.exports = { openDatabase, closeDatabase, getDb };
