'use strict';

/**
 * Returns fresh sql.js statement wrappers on every call.
 * sql.js statements MUST be created fresh and freed after each use.
 * Never cache prepared statements with sql.js.
 */
function getStatements() {
  const { getDb } = require('./database');
  const db = getDb();

  function run(sql, params) {
    const stmt = db.prepare(sql);
    stmt.run(params);
    stmt.free();
  }

function get(sql, params) {
    const stmt = db.prepare(sql);
    const p = params !== undefined ? (Array.isArray(params) ? params : [params]) : undefined;
    const row = stmt.step(p) ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }
  

  function all(sql, params) {
    const stmt = db.prepare(sql);
    const rows = [];
    if (params !== undefined) {
      const p = Array.isArray(params) ? params : [params];
      while (stmt.step(p)) rows.push(stmt.getAsObject());
    } else {
      while (stmt.step()) rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }


  return {
    // ── downloads ──────────────────────────────────────────────────────────
    insertDownload: {
      run: (p) => run(`
        INSERT INTO downloads
          (id, url, title, filename, save_path, category, status,
           file_size, downloaded, mime_type, referrer, headers,
           is_hls, is_dash, is_playlist, playlist_id, priority, max_retries)
        VALUES
          (:id, :url, :title, :filename, :save_path, :category, :status,
           :file_size, :downloaded, :mime_type, :referrer, :headers,
           :is_hls, :is_dash, :is_playlist, :playlist_id, :priority, :max_retries)
      `, p)
    },

    getDownload: {
      get: (id) => get(`SELECT * FROM downloads WHERE id = ?`, id)
    },

    getAllDownloads: {
      all: () => all(`SELECT * FROM downloads ORDER BY created_at DESC`)
    },

    getDownloadsByStatus: {
      all: (status) => all(`SELECT * FROM downloads WHERE status = ? ORDER BY priority DESC, created_at ASC`, status)
    },

    updateDownloadProgress: {
      run: (p) => run(`
        UPDATE downloads
        SET downloaded = :downloaded, speed = :speed,
            progress = :progress, eta = :eta, updated_at = datetime('now')
        WHERE id = :id
      `, p)
    },

    updateDownloadStatus: {
      run: (p) => run(`UPDATE downloads SET status = :status, updated_at = datetime('now') WHERE id = :id`, p)
    },

    updateDownloadStarted: {
      run: (p) => run(`UPDATE downloads SET status = 'downloading', started_at = datetime('now'), updated_at = datetime('now') WHERE id = :id`, p)
    },

    updateDownloadCompleted: {
      run: (p) => run(`UPDATE downloads SET status = 'completed', progress = 100, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = :id`, p)
    },

    updateDownloadError: {
      run: (p) => run(`UPDATE downloads SET status = 'error', error_msg = :error_msg, updated_at = datetime('now') WHERE id = :id`, p)
    },

    updateDownloadChunks: {
      run: (p) => run(`UPDATE downloads SET chunks = :chunks, updated_at = datetime('now') WHERE id = :id`, p)
    },

    updateDownloadFileInfo: {
      run: (p) => run(`UPDATE downloads SET file_size = :file_size, filename = :filename, mime_type = :mime_type, updated_at = datetime('now') WHERE id = :id`, p)
    },

    incrementRetries: {
      run: (id) => run(`UPDATE downloads SET retries = retries + 1, updated_at = datetime('now') WHERE id = ?`, [id])
    },

    deleteDownload: {
      run: (id) => run(`DELETE FROM downloads WHERE id = ?`, [id])
    },

    getActiveDownloads: {
      all: () => all(`SELECT * FROM downloads WHERE status IN ('downloading', 'queued', 'merging') ORDER BY priority DESC`)
    },

    getPendingDownloads: {
      all: (limit) => all(`SELECT * FROM downloads WHERE status IN ('pending', 'queued') ORDER BY priority DESC, created_at ASC LIMIT ?`, limit)
    },

    // ── chunks ─────────────────────────────────────────────────────────────
    insertChunk: {
      run: (p) => run(`
        INSERT OR REPLACE INTO download_chunks
          (id, download_id, chunk_index, start_byte, end_byte, downloaded, status, temp_file)
        VALUES
          (:id, :download_id, :chunk_index, :start_byte, :end_byte, :downloaded, :status, :temp_file)
      `, p)
    },

    getChunks: {
      all: (downloadId) => all(`SELECT * FROM download_chunks WHERE download_id = ? ORDER BY chunk_index ASC`, downloadId)
    },

    updateChunkProgress: {
      run: (p) => run(`UPDATE download_chunks SET downloaded = :downloaded, status = :status, updated_at = datetime('now') WHERE id = :id`, p)
    },

    updateChunkStatus: {
      run: (p) => run(`UPDATE download_chunks SET status = :status, updated_at = datetime('now') WHERE id = :id`, p)
    },

    deleteChunks: {
      run: (downloadId) => run(`DELETE FROM download_chunks WHERE download_id = ?`, [downloadId])
    },

    getIncompleteChunks: {
      all: (downloadId) => all(`SELECT * FROM download_chunks WHERE download_id = ? AND status != 'completed' ORDER BY chunk_index ASC`, downloadId)
    },

    // ── playlists ──────────────────────────────────────────────────────────
    insertPlaylist: {
      run: (p) => run(`INSERT INTO playlists (id, url, title, total) VALUES (:id, :url, :title, :total)`, p)
    },

    getPlaylist: {
      get: (id) => get(`SELECT * FROM playlists WHERE id = ?`, id)
    },

    updatePlaylistProgress: {
      run: (id) => run(`UPDATE playlists SET completed = completed + 1, status = CASE WHEN completed + 1 >= total THEN 'completed' ELSE 'downloading' END, updated_at = datetime('now') WHERE id = ?`, [id])
    },

    // ── settings ───────────────────────────────────────────────────────────
    setSetting: {
      run: (p) => run(`INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, p)
    },

    getSetting: {
      get: (key) => get(`SELECT value FROM settings WHERE key = ?`, key)
    },

    getAllSettings: {
      all: () => all(`SELECT key, value FROM settings`)
    },

    // ── stats ──────────────────────────────────────────────────────────────
    upsertStats: {
      run: (p) => run(`
        INSERT INTO stats (date, downloaded, count)
        VALUES (date('now'), :downloaded, 1)
        ON CONFLICT(date) DO UPDATE SET downloaded = downloaded + excluded.downloaded, count = count + 1
      `, p)
    },

    getStats: {
      all: () => all(`SELECT * FROM stats ORDER BY date DESC LIMIT 30`)
    },

    getTotalStats: {
      get: () => get(`SELECT COALESCE(SUM(downloaded), 0) AS total_bytes, COALESCE(SUM(count), 0) AS total_count FROM stats`)
    },
  };
}

function resetStatements() {
  // No-op with fresh-statement pattern — nothing to free
}

module.exports = { getStatements, resetStatements };