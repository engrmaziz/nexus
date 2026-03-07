'use strict';

// The db wrapper in database.js already provides better-sqlite3 compatible API
// (.prepare().run() / .get() / .all()) so we just use that directly.

function getStatements() {
  const { getDb } = require('./database');
  const db = getDb();

  return {
    insertDownload:          db.prepare(`INSERT INTO downloads
      (id, url, title, filename, save_path, category, status,
       file_size, downloaded, mime_type, referrer, headers,
       is_hls, is_dash, is_playlist, playlist_id, priority, max_retries)
      VALUES
      (@id, @url, @title, @filename, @save_path, @category, @status,
       @file_size, @downloaded, @mime_type, @referrer, @headers,
       @is_hls, @is_dash, @is_playlist, @playlist_id, @priority, @max_retries)`),

    getDownload:             db.prepare(`SELECT * FROM downloads WHERE id = ?`),
    getAllDownloads:          db.prepare(`SELECT * FROM downloads ORDER BY created_at DESC`),
    getDownloadsByStatus:    db.prepare(`SELECT * FROM downloads WHERE status = ? ORDER BY priority DESC, created_at ASC`),
    getActiveDownloads:      db.prepare(`SELECT * FROM downloads WHERE status IN ('downloading','queued','merging') ORDER BY priority DESC`),
    getPendingDownloads:     db.prepare(`SELECT * FROM downloads WHERE status IN ('pending','queued') ORDER BY priority DESC, created_at ASC LIMIT ?`),

    updateDownloadProgress:  db.prepare(`UPDATE downloads SET downloaded=@downloaded, speed=@speed, progress=@progress, eta=@eta, updated_at=datetime('now') WHERE id=@id`),
    updateYtdlpProgress:     db.prepare(`UPDATE downloads SET file_size=@file_size, downloaded=@downloaded, speed=@speed, progress=@progress, updated_at=datetime('now') WHERE id=@id`),
    updateDownloadFinalSize: db.prepare(`UPDATE downloads SET file_size=@file_size, downloaded=@downloaded, updated_at=datetime('now') WHERE id=@id`),
    updateDownloadStatus:    db.prepare(`UPDATE downloads SET status=@status, updated_at=datetime('now') WHERE id=@id`),
    updateDownloadStarted:   db.prepare(`UPDATE downloads SET status='downloading', started_at=datetime('now'), updated_at=datetime('now') WHERE id=@id`),
    updateDownloadCompleted: db.prepare(`UPDATE downloads SET status='completed', progress=100, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=@id`),
    updateDownloadError: db.prepare(`UPDATE downloads SET status='error', error_message=@error_message, updated_at=datetime('now') WHERE id=@id`),
    updateDownloadTitle:     db.prepare(`UPDATE downloads SET title=@title, filename=@title, updated_at=datetime('now') WHERE id=@id`),
    updateDownloadChunks:    db.prepare(`UPDATE downloads SET chunks=@chunks, updated_at=datetime('now') WHERE id=@id`),
    updateDownloadFileInfo:  db.prepare(`UPDATE downloads SET file_size=@file_size, filename=@filename, mime_type=@mime_type, updated_at=datetime('now') WHERE id=@id`),
    updateDownloadFilePath:  db.prepare(`UPDATE downloads SET file_path=@file_path, updated_at=datetime('now') WHERE id=@id`),
    incrementRetries:        db.prepare(`UPDATE downloads SET retries=retries+1, updated_at=datetime('now') WHERE id=?`),
    deleteDownload:          db.prepare(`DELETE FROM downloads WHERE id=?`),

    insertChunk:             db.prepare(`INSERT OR REPLACE INTO download_chunks
      (id, download_id, chunk_index, start_byte, end_byte, downloaded, status, temp_file)
      VALUES (@id, @download_id, @chunk_index, @start_byte, @end_byte, @downloaded, @status, @temp_file)`),
    getChunks:               db.prepare(`SELECT * FROM download_chunks WHERE download_id=? ORDER BY chunk_index ASC`),
    updateChunkProgress:     db.prepare(`UPDATE download_chunks SET downloaded=@downloaded, status=@status, updated_at=datetime('now') WHERE id=@id`),
    updateChunkStatus:       db.prepare(`UPDATE download_chunks SET status=@status, updated_at=datetime('now') WHERE id=@id`),
    deleteChunks:            db.prepare(`DELETE FROM download_chunks WHERE download_id=?`),
    getIncompleteChunks:     db.prepare(`SELECT * FROM download_chunks WHERE download_id=? AND status!='completed' ORDER BY chunk_index ASC`),

    insertPlaylist:          db.prepare(`INSERT INTO playlists (id, url, title, total) VALUES (@id, @url, @title, @total)`),
    getPlaylist:             db.prepare(`SELECT * FROM playlists WHERE id=?`),
    updatePlaylistProgress:  db.prepare(`UPDATE playlists SET completed=completed+1, status=CASE WHEN completed+1>=total THEN 'completed' ELSE 'downloading' END, updated_at=datetime('now') WHERE id=?`),

    setSetting:              db.prepare(`INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`),
    getSetting:              db.prepare(`SELECT value FROM settings WHERE key=?`),
    getAllSettings:           db.prepare(`SELECT key, value FROM settings`),

    upsertStats:             db.prepare(`INSERT INTO stats (date, downloaded, count) VALUES (date('now'), @downloaded, 1) ON CONFLICT(date) DO UPDATE SET downloaded=downloaded+excluded.downloaded, count=count+1`),
    getStats:                db.prepare(`SELECT * FROM stats ORDER BY date DESC LIMIT 30`),
    getTotalStats:           db.prepare(`SELECT COALESCE(SUM(downloaded),0) AS total_bytes, COALESCE(SUM(count),0) AS total_count FROM stats`),
  };
}

function resetStatements() {}

module.exports = { getStatements, resetStatements };