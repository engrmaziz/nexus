'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const BetterSqlite3 = require('better-sqlite3');
const logger = require('../utils/logger');
const migrations = require('./migrations');

const DB_PATH = path.join(
  process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
  'nexus.db'
);

let _db = null;

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  -- Schema version tracking
  CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER NOT NULL,
    applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- ── downloads ──────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS downloads (
    id                  TEXT    PRIMARY KEY,
    title               TEXT    NOT NULL    DEFAULT '',
    url                 TEXT    NOT NULL,
    final_url           TEXT,
    type                TEXT    NOT NULL    DEFAULT 'file',
    status              TEXT    NOT NULL    DEFAULT 'queued'
                                            CHECK(status IN (
                                              'queued','connecting','downloading','paused',
                                              'merging','completed','error','cancelled','pending'
                                            )),
    progress            REAL    NOT NULL    DEFAULT 0,
    speed               REAL    NOT NULL    DEFAULT 0,
    avg_speed           REAL    NOT NULL    DEFAULT 0,
    size                INTEGER NOT NULL    DEFAULT 0,
    downloaded          INTEGER NOT NULL    DEFAULT 0,
    file_path           TEXT,
    temp_path           TEXT,
    page_url            TEXT,
    page_title          TEXT,
    thumbnail_url       TEXT,
    category            TEXT    NOT NULL    DEFAULT 'Other',
    quality             TEXT,
    format              TEXT,
    chunks_total        INTEGER NOT NULL    DEFAULT 0,
    chunks_done         INTEGER NOT NULL    DEFAULT 0,
    playlist_id         TEXT,
    playlist_index      INTEGER,
    subtitles_downloaded INTEGER NOT NULL   DEFAULT 0,
    error_message       TEXT,
    retry_count         INTEGER NOT NULL    DEFAULT 0,
    created_at          TEXT    NOT NULL    DEFAULT (datetime('now')),
    updated_at          TEXT    NOT NULL    DEFAULT (datetime('now')),
    completed_at        TEXT,
    eta_seconds         INTEGER NOT NULL    DEFAULT 0,

    -- Legacy / internal columns (kept for backward compat with queries.js)
    filename            TEXT    NOT NULL    DEFAULT '',
    save_path           TEXT    NOT NULL    DEFAULT '',
    mime_type           TEXT,
    referrer            TEXT,
    headers             TEXT    NOT NULL    DEFAULT '{}',
    chunks              TEXT    NOT NULL    DEFAULT '[]',
    is_hls              INTEGER NOT NULL    DEFAULT 0,
    is_dash             INTEGER NOT NULL    DEFAULT 0,
    is_playlist         INTEGER NOT NULL    DEFAULT 0,
    priority            INTEGER NOT NULL    DEFAULT 5,
    max_retries         INTEGER NOT NULL    DEFAULT 5,
    retries             INTEGER NOT NULL    DEFAULT 0,
    file_size           INTEGER NOT NULL    DEFAULT 0,
    started_at          TEXT,
    finished_at         TEXT,
    eta                 INTEGER NOT NULL    DEFAULT 0,
    subtitle_url        TEXT,
    subtitle_lang       TEXT
  );

  -- ── playlists ──────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS playlists (
    id               TEXT    PRIMARY KEY,
    title            TEXT    NOT NULL    DEFAULT '',
    url              TEXT    NOT NULL    DEFAULT '',
    site             TEXT,
    total_count      INTEGER NOT NULL    DEFAULT 0,
    downloaded_count INTEGER NOT NULL    DEFAULT 0,
    status           TEXT    NOT NULL    DEFAULT 'queued'
                                         CHECK(status IN ('queued','downloading','completed','error','pending')),
    quality          TEXT,
    created_at       TEXT    NOT NULL    DEFAULT (datetime('now')),
    updated_at       TEXT    NOT NULL    DEFAULT (datetime('now')),

    -- Legacy aliases
    total            INTEGER NOT NULL    DEFAULT 0,
    completed        INTEGER NOT NULL    DEFAULT 0
  );

  -- ── settings ───────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── speed_history ──────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS speed_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id TEXT    NOT NULL,
    timestamp   TEXT    NOT NULL DEFAULT (datetime('now')),
    speed       REAL    NOT NULL DEFAULT 0,
    downloaded  INTEGER NOT NULL DEFAULT 0
  );

  -- ── ai_schedule ────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS ai_schedule (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    hour           INTEGER NOT NULL,
    day_of_week    INTEGER NOT NULL,
    download_count INTEGER NOT NULL DEFAULT 0,
    avg_speed      REAL    NOT NULL DEFAULT 0
  );

  -- ── download_chunks (internal; used by queries.js) ─────────────────────────
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

  -- ── daily stats ────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS stats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT    NOT NULL,
    downloaded INTEGER NOT NULL DEFAULT 0,
    upload     INTEGER NOT NULL DEFAULT 0,
    count      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(date)
  );

  -- ── indexes ────────────────────────────────────────────────────────────────
  CREATE INDEX IF NOT EXISTS idx_downloads_status    ON downloads(status);
  CREATE INDEX IF NOT EXISTS idx_downloads_created   ON downloads(created_at);
  CREATE INDEX IF NOT EXISTS idx_downloads_playlist  ON downloads(playlist_id);
  CREATE INDEX IF NOT EXISTS idx_downloads_url       ON downloads(url);
  CREATE INDEX IF NOT EXISTS idx_chunks_download_id  ON download_chunks(download_id);
  CREATE INDEX IF NOT EXISTS idx_speed_download_id   ON speed_history(download_id);
  CREATE INDEX IF NOT EXISTS idx_schedule_hour       ON ai_schedule(hour, day_of_week);
`;

// ─── Open / Close ─────────────────────────────────────────────────────────────

/**
 * Open (or create) the SQLite database.
 * Returns the singleton db instance.
 */
function openDatabase() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new BetterSqlite3(DB_PATH, { verbose: null });

  // Performance & reliability PRAGMAs
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('cache_size = -32000');    // 32 MB page cache
  _db.pragma('temp_store = MEMORY');
  _db.pragma('mmap_size = 268435456');  // 256 MB
  _db.pragma('wal_autocheckpoint = 1000');

  _db.exec(SCHEMA_SQL);
  migrations.run(_db);

  logger.info('Database opened', { path: DB_PATH });
  return _db;
}

function closeDatabase() {
  if (_db) {
    try {
      _db.close();
      logger.info('Database closed');
    } catch (err) {
      logger.error('Error closing database', { err: err.message });
    }
    _db = null;
  }
}

function getDb() {
  if (!_db) throw new Error('Database not opened. Call openDatabase() first.');
  return _db;
}

// ─── High-level `db` facade ───────────────────────────────────────────────────

/**
 * A convenience facade used by parts of the app that prefer a method-based API.
 * All methods throw if the database has not been opened yet.
 */
const db = {
  // ── downloads ──────────────────────────────────────────────────────────────

  /**
   * Insert or replace a download record.
   * @param {object} record  Must include at least { id, url }.
   */
  save(record) {
    const d = getDb();
    const now = new Date().toISOString();
    d.prepare(`
      INSERT INTO downloads
        (id, url, title, filename, save_path, category, status,
         file_size, downloaded, mime_type, referrer, headers,
         is_hls, is_dash, is_playlist, playlist_id, priority, max_retries,
         created_at, updated_at)
      VALUES
        (@id, @url, @title, @filename, @save_path, @category, @status,
         @file_size, @downloaded, @mime_type, @referrer, @headers,
         @is_hls, @is_dash, @is_playlist, @playlist_id, @priority, @max_retries,
         @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        url         = excluded.url,
        title       = excluded.title,
        status      = excluded.status,
        downloaded  = excluded.downloaded,
        updated_at  = excluded.updated_at
    `).run({
      id:           record.id,
      url:          record.url || '',
      title:        record.title || '',
      filename:     record.filename || record.title || '',
      save_path:    record.save_path || record.filePath || '',
      category:     record.category || 'Other',
      status:       record.status || 'queued',
      file_size:    record.file_size || record.size || 0,
      downloaded:   record.downloaded || 0,
      mime_type:    record.mime_type || '',
      referrer:     record.referrer || '',
      headers:      record.headers || '{}',
      is_hls:       record.is_hls ? 1 : 0,
      is_dash:      record.is_dash ? 1 : 0,
      is_playlist:  record.is_playlist ? 1 : 0,
      playlist_id:  record.playlist_id || null,
      priority:     record.priority || 5,
      max_retries:  record.max_retries || 5,
      created_at:   record.created_at || now,
      updated_at:   now,
    });
  },

  /**
   * Partial update of a download record.
   * @param {string} id
   * @param {object} changes  Key-value pairs to update.
   */
  update(id, changes) {
    const d = getDb();
    const allowed = [
      'title', 'status', 'progress', 'speed', 'avg_speed', 'size', 'downloaded',
      'file_path', 'category', 'quality', 'format', 'chunks_total', 'chunks_done',
      'error_message', 'retry_count', 'completed_at', 'eta_seconds',
      // legacy
      'file_size', 'filename', 'save_path', 'error_msg', 'retries', 'eta',
      'started_at', 'finished_at',
    ];
    const sets = Object.keys(changes)
      .filter((k) => allowed.includes(k))
      .map((k) => `${k} = @${k}`)
      .join(', ');
    if (!sets) return;
    d.prepare(`UPDATE downloads SET ${sets}, updated_at = datetime('now') WHERE id = @_id`)
      .run({ ...changes, _id: id });
  },

  getAll() {
    return getDb().prepare('SELECT * FROM downloads ORDER BY created_at DESC').all();
  },

  getById(id) {
    return getDb().prepare('SELECT * FROM downloads WHERE id = ?').get(id);
  },

  delete(id) {
    getDb().prepare('DELETE FROM downloads WHERE id = ?').run(id);
  },

  getByStatus(status) {
    return getDb()
      .prepare('SELECT * FROM downloads WHERE status = ? ORDER BY priority DESC, created_at ASC')
      .all(status);
  },

  getByPlaylist(playlistId) {
    return getDb()
      .prepare('SELECT * FROM downloads WHERE playlist_id = ? ORDER BY playlist_index ASC')
      .all(playlistId);
  },

  updateStatus(id, status) {
    getDb()
      .prepare(`UPDATE downloads SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, id);
  },

  updateProgress(id, { downloaded, speed, avgSpeed, progress, eta, chunksTotal, chunksDone }) {
    getDb().prepare(`
      UPDATE downloads
      SET downloaded   = @downloaded,
          speed        = @speed,
          avg_speed    = @avgSpeed,
          progress     = @progress,
          eta_seconds  = @eta,
          chunks_total = @chunksTotal,
          chunks_done  = @chunksDone,
          updated_at   = datetime('now')
      WHERE id = @id
    `).run({ id, downloaded: downloaded || 0, speed: speed || 0, avgSpeed: avgSpeed || 0,
              progress: progress || 0, eta: eta || 0, chunksTotal: chunksTotal || 0,
              chunksDone: chunksDone || 0 });
  },

  // ── speed_history ──────────────────────────────────────────────────────────

  addSpeedSample(downloadId, speed, downloaded) {
    getDb().prepare(`
      INSERT INTO speed_history (download_id, speed, downloaded)
      VALUES (?, ?, ?)
    `).run(downloadId, speed, downloaded);
  },

  // ── ai_schedule ────────────────────────────────────────────────────────────

  getScheduleData() {
    return getDb().prepare('SELECT * FROM ai_schedule').all();
  },

  updateSchedule(hour, dayOfWeek, speedSample) {
    const d = getDb();
    const existing = d
      .prepare('SELECT * FROM ai_schedule WHERE hour = ? AND day_of_week = ?')
      .get(hour, dayOfWeek);

    if (existing) {
      const newCount = existing.download_count + 1;
      const newAvg = (existing.avg_speed * existing.download_count + speedSample) / newCount;
      d.prepare(`
        UPDATE ai_schedule
        SET download_count = ?, avg_speed = ?
        WHERE hour = ? AND day_of_week = ?
      `).run(newCount, newAvg, hour, dayOfWeek);
    } else {
      d.prepare(`
        INSERT INTO ai_schedule (hour, day_of_week, download_count, avg_speed)
        VALUES (?, ?, 1, ?)
      `).run(hour, dayOfWeek, speedSample);
    }
  },

  // ── settings ───────────────────────────────────────────────────────────────

  getSetting(key) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  setSetting(key, value) {
    getDb().prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, String(value));
  },

  // ── stats ──────────────────────────────────────────────────────────────────

  getStats() {
    const history = getDb().prepare('SELECT * FROM stats ORDER BY date DESC LIMIT 30').all();
    const totals = getDb().prepare(`
      SELECT
        COALESCE(SUM(downloaded), 0) AS total_bytes,
        COALESCE(SUM(count),      0) AS total_count
      FROM stats
    `).get();
    return { history, totals };
  },
};

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Initialize the database. Call once at app startup.
 * @returns {BetterSqlite3.Database}
 */
function initDatabase() {
  return openDatabase();
}

module.exports = { initDatabase, openDatabase, closeDatabase, getDb, db };
