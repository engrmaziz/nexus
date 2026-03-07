'use strict';

/**
 * Create a statement descriptor that prepares a fresh sql.js statement on
 * every call, executes it, then frees it.  This avoids the "Statement closed"
 * error that occurs when a cached prepared statement is freed (or invalidated)
 * before it is used again.
 *
 * The returned object exposes the same .run() / .get() / .all() surface as
 * a better-sqlite3 statement, but delegates to a brand-new _SqlJsStatement
 * wrapper each time so the underlying WASM statement is always fresh.
 */
function _makeStmt(db, sql) {
  return {
    run(...args) {
      const stmt = db.prepare(sql);
      try {
        return stmt.run(...args);
      } finally {
        stmt.free();
      }
    },
    get(...args) {
      const stmt = db.prepare(sql);
      try {
        return stmt.get(...args);
      } finally {
        stmt.free();
      }
    },
    all(...args) {
      const stmt = db.prepare(sql);
      try {
        return stmt.all(...args);
      } finally {
        stmt.free();
      }
    },
  };
}

/**
 * Return statement descriptors for every query used by the application.
 *
 * Because each descriptor creates a fresh prepared statement on every call
 * (and frees it immediately after), there is no risk of "Statement closed"
 * errors due to cached statements being freed by resetStatements() or the
 * database being reopened after a migration.
 */
function getStatements() {
  // Lazy require avoids capturing a stale reference during circular-dependency
  // resolution (database → migrations → queries → database).
  const { getDb } = require('./database');
  const db = getDb();

  return {
    // ── downloads ──────────────────────────────────────────────────────────
    insertDownload: _makeStmt(db, `
      INSERT INTO downloads
        (id, url, title, filename, save_path, category, status,
         file_size, downloaded, mime_type, referrer, headers,
         is_hls, is_dash, is_playlist, playlist_id, priority, max_retries)
      VALUES
        (@id, @url, @title, @filename, @save_path, @category, @status,
         @file_size, @downloaded, @mime_type, @referrer, @headers,
         @is_hls, @is_dash, @is_playlist, @playlist_id, @priority, @max_retries)
    `),

    getDownload: _makeStmt(db,
      `SELECT * FROM downloads WHERE id = ?`
    ),

    getAllDownloads: _makeStmt(db,
      `SELECT * FROM downloads ORDER BY created_at DESC`
    ),

    getDownloadsByStatus: _makeStmt(db,
      `SELECT * FROM downloads WHERE status = ? ORDER BY priority DESC, created_at ASC`
    ),

    updateDownloadProgress: _makeStmt(db, `
      UPDATE downloads
      SET downloaded  = @downloaded,
          speed       = @speed,
          progress    = @progress,
          eta         = @eta,
          updated_at  = datetime('now')
      WHERE id = @id
    `),

    updateDownloadStatus: _makeStmt(db, `
      UPDATE downloads
      SET status     = @status,
          updated_at = datetime('now')
      WHERE id = @id
    `),

    updateDownloadStarted: _makeStmt(db, `
      UPDATE downloads
      SET status     = 'downloading',
          started_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = @id
    `),

    updateDownloadCompleted: _makeStmt(db, `
      UPDATE downloads
      SET status      = 'completed',
          progress    = 100,
          finished_at = datetime('now'),
          updated_at  = datetime('now')
      WHERE id = @id
    `),

    updateDownloadError: _makeStmt(db, `
      UPDATE downloads
      SET status     = 'error',
          error_msg  = @error_msg,
          updated_at = datetime('now')
      WHERE id = @id
    `),

    updateDownloadChunks: _makeStmt(db, `
      UPDATE downloads
      SET chunks     = @chunks,
          updated_at = datetime('now')
      WHERE id = @id
    `),

    updateDownloadFileInfo: _makeStmt(db, `
      UPDATE downloads
      SET file_size  = @file_size,
          filename   = @filename,
          mime_type  = @mime_type,
          updated_at = datetime('now')
      WHERE id = @id
    `),

    incrementRetries: _makeStmt(db, `
      UPDATE downloads
      SET retries    = retries + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `),

    deleteDownload: _makeStmt(db,
      `DELETE FROM downloads WHERE id = ?`
    ),

    getActiveDownloads: _makeStmt(db, `
      SELECT * FROM downloads
      WHERE status IN ('downloading', 'queued', 'merging')
      ORDER BY priority DESC
    `),

    getPendingDownloads: _makeStmt(db, `
      SELECT * FROM downloads
      WHERE status IN ('pending', 'queued')
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `),

    // ── chunks ─────────────────────────────────────────────────────────────
    insertChunk: _makeStmt(db, `
      INSERT OR REPLACE INTO download_chunks
        (id, download_id, chunk_index, start_byte, end_byte,
         downloaded, status, temp_file)
      VALUES
        (@id, @download_id, @chunk_index, @start_byte, @end_byte,
         @downloaded, @status, @temp_file)
    `),

    getChunks: _makeStmt(db,
      `SELECT * FROM download_chunks WHERE download_id = ? ORDER BY chunk_index ASC`
    ),

    updateChunkProgress: _makeStmt(db, `
      UPDATE download_chunks
      SET downloaded = @downloaded,
          status     = @status,
          updated_at = datetime('now')
      WHERE id = @id
    `),

    updateChunkStatus: _makeStmt(db, `
      UPDATE download_chunks
      SET status     = @status,
          updated_at = datetime('now')
      WHERE id = @id
    `),

    deleteChunks: _makeStmt(db,
      `DELETE FROM download_chunks WHERE download_id = ?`
    ),

    getIncompleteChunks: _makeStmt(db, `
      SELECT * FROM download_chunks
      WHERE download_id = ? AND status != 'completed'
      ORDER BY chunk_index ASC
    `),

    // ── playlists ──────────────────────────────────────────────────────────
    insertPlaylist: _makeStmt(db, `
      INSERT INTO playlists (id, url, title, total)
      VALUES (@id, @url, @title, @total)
    `),

    getPlaylist: _makeStmt(db,
      `SELECT * FROM playlists WHERE id = ?`
    ),

    updatePlaylistProgress: _makeStmt(db, `
      UPDATE playlists
      SET completed  = completed + 1,
          status     = CASE WHEN completed + 1 >= total THEN 'completed' ELSE 'downloading' END,
          updated_at = datetime('now')
      WHERE id = ?
    `),

    // ── settings ───────────────────────────────────────────────────────────
    setSetting: _makeStmt(db, `
      INSERT INTO settings (key, value)
      VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `),

    getSetting: _makeStmt(db,
      `SELECT value FROM settings WHERE key = ?`
    ),

    getAllSettings: _makeStmt(db,
      `SELECT key, value FROM settings`
    ),

    // ── stats ──────────────────────────────────────────────────────────────
    upsertStats: _makeStmt(db, `
      INSERT INTO stats (date, downloaded, count)
      VALUES (date('now'), @downloaded, 1)
      ON CONFLICT(date) DO UPDATE
        SET downloaded = downloaded + excluded.downloaded,
            count      = count + 1
    `),

    getStats: _makeStmt(db, `
      SELECT * FROM stats ORDER BY date DESC LIMIT 30
    `),

    getTotalStats: _makeStmt(db, `
      SELECT
        COALESCE(SUM(downloaded), 0) AS total_bytes,
        COALESCE(SUM(count), 0)      AS total_count
      FROM stats
    `),
  };
}

/**
 * No-op kept for backward compatibility with migrations.js.
 * With the fresh-statement pattern there are no cached statements to free.
 */
function resetStatements() {}

module.exports = { getStatements, resetStatements };
