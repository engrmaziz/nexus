'use strict';

const logger = require('../utils/logger');

/**
 * AIScheduler – learns user download patterns and suggests optimal times.
 *
 * Data is stored in the `ai_schedule` table (created in SCHEMA_SQL in database.js).
 *
 * The table schema:
 *   CREATE TABLE IF NOT EXISTS ai_schedule (
 *     id             INTEGER PRIMARY KEY AUTOINCREMENT,
 *     hour           INTEGER NOT NULL,
 *     day_of_week    INTEGER NOT NULL,
 *     download_count INTEGER NOT NULL DEFAULT 0,
 *     avg_speed      REAL    NOT NULL DEFAULT 0
 *   );
 */

// "Peak" hours during which large downloads should be deferred
const PEAK_START = 8;   // 08:00
const PEAK_END   = 22;  // 22:00
const LARGE_FILE_THRESHOLD = 1024 * 1024 * 1024; // 1 GB

// setInterval handles for scheduled downloads: downloadId → intervalHandle
const _scheduleHandles = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _getDbFacade() {
  try {
    const { db } = require('../db/database');
    return db;
  } catch (_) {
    return null;
  }
}

function _getRawDb() {
  try {
    const { getDb } = require('../db/database');
    return getDb();
  } catch (_) {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a completed download.
 * @param {object} [opts]
 * @param {number} [opts.avgSpeed]   Average speed in bytes/s (0 if unknown)
 */
function recordDownload(opts = {}) {
  const { avgSpeed = 0 } = opts;
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();

  try {
    const facade = _getDbFacade();
    if (facade && facade.updateSchedule) {
      facade.updateSchedule(hour, dayOfWeek, avgSpeed);
      return;
    }

    const db = _getRawDb();
    if (!db) return;
    const existing = db.prepare(
      'SELECT * FROM ai_schedule WHERE hour = ? AND day_of_week = ?'
    ).get(hour, dayOfWeek);

    if (existing) {
      const newCount = existing.download_count + 1;
      const newAvg = (existing.avg_speed * existing.download_count + avgSpeed) / newCount;
      db.prepare(
        'UPDATE ai_schedule SET download_count = ?, avg_speed = ? WHERE hour = ? AND day_of_week = ?'
      ).run(newCount, newAvg, hour, dayOfWeek);
    } else {
      db.prepare(
        'INSERT INTO ai_schedule (hour, day_of_week, download_count, avg_speed) VALUES (?, ?, 1, ?)'
      ).run(hour, dayOfWeek, avgSpeed);
    }
  } catch (err) {
    logger.warn('AIScheduler.recordDownload failed', { err: err.message });
  }
}

/**
 * Find the hour with the best historical speeds and fewest user interactions.
 * @returns {{ recommendedHour: number, reason: string, avgSpeedAtThatHour: number }}
 */
function getRecommendedTime() {
  try {
    const db = _getRawDb();
    if (!db) return _defaultRecommendation();

    const row = db.prepare(`
      SELECT hour,
             SUM(download_count) AS total_count,
             SUM(avg_speed * download_count) / NULLIF(SUM(download_count), 0) AS weighted_avg_speed
      FROM ai_schedule
      GROUP BY hour
      ORDER BY weighted_avg_speed DESC, total_count ASC
      LIMIT 1
    `).get();

    if (!row) return _defaultRecommendation();

    const recommendedHour = row.hour;
    const avgSpeedAtThatHour = row.weighted_avg_speed || 0;
    const reason = `Hour ${recommendedHour}:00 historically has the highest average speed (${_formatSpeed(avgSpeedAtThatHour)}) and fewest user interactions.`;

    return { recommendedHour, reason, avgSpeedAtThatHour };
  } catch (err) {
    logger.warn('AIScheduler.getRecommendedTime failed', { err: err.message });
    return _defaultRecommendation();
  }
}

function _defaultRecommendation() {
  return {
    recommendedHour: 2,
    reason: 'Default off-peak hour (02:00) – no historical data yet.',
    avgSpeedAtThatHour: 0,
  };
}

function _formatSpeed(bytesPerSec) {
  if (!bytesPerSec) return '(unknown)';
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
}

/**
 * Decide whether a download should be auto-scheduled.
 * @param {{ size: number, file_size: number }} download
 * @returns {{ schedule: boolean, suggestedTime?: number, reason?: string }}
 */
function shouldAutoSchedule(download) {
  const size = (download && (download.size || download.file_size)) || 0;
  const currentHour = new Date().getHours();
  const isPeak = currentHour >= PEAK_START && currentHour < PEAK_END;

  if (size > LARGE_FILE_THRESHOLD && isPeak) {
    const { recommendedHour, reason } = getRecommendedTime();
    return {
      schedule: true,
      suggestedTime: recommendedHour,
      reason: `File is over 1 GB and it is currently peak hours (${PEAK_START}:00–${PEAK_END}:00). ${reason}`,
    };
  }

  return { schedule: false };
}

/**
 * Schedule a large download to start at a specific hour.
 * @param {string} downloadId
 * @param {number} hour  0–23
 */
function scheduleLargeDownload(downloadId, hour) {
  if (_scheduleHandles.has(downloadId)) {
    clearInterval(_scheduleHandles.get(downloadId));
    _scheduleHandles.delete(downloadId);
  }

  try {
    const db = _getRawDb();
    if (db) {
      db.prepare(
        "UPDATE downloads SET status = 'scheduled', updated_at = datetime('now') WHERE id = ?"
      ).run(downloadId);
    }
  } catch (_) {}

  logger.info('AIScheduler: large download scheduled', { downloadId, hour });

  const handle = setInterval(() => {
    const now = new Date();
    if (now.getHours() === hour) {
      clearInterval(handle);
      _scheduleHandles.delete(downloadId);
      _activateScheduled(downloadId);
    }
  }, 60_000);

  _scheduleHandles.set(downloadId, handle);
}

function _activateScheduled(downloadId) {
  try {
    const db = _getRawDb();
    if (db) {
      db.prepare(
        "UPDATE downloads SET status = 'queued', updated_at = datetime('now') WHERE id = ? AND status = 'scheduled'"
      ).run(downloadId);
    }
    logger.info('AIScheduler: scheduled download activated', { downloadId });
    try {
      const dm = require('../engine/downloadManager');
      if (dm._processQueue) dm._processQueue();
    } catch (_) {}
  } catch (err) {
    logger.warn('AIScheduler._activateScheduled failed', { err: err.message });
  }
}

/**
 * Return all schedule data for the renderer.
 * @returns {{ rows: object[], recommendation: object }}
 */
function getScheduleData() {
  try {
    const facade = _getDbFacade();
    if (facade && facade.getScheduleData) {
      return { rows: facade.getScheduleData(), recommendation: getRecommendedTime() };
    }

    const db = _getRawDb();
    if (!db) return { rows: [], recommendation: _defaultRecommendation() };

    const rows = db.prepare(
      'SELECT hour, day_of_week, download_count, avg_speed FROM ai_schedule ORDER BY hour ASC, day_of_week ASC'
    ).all();

    return { rows, recommendation: getRecommendedTime() };
  } catch (err) {
    logger.warn('AIScheduler.getScheduleData failed', { err: err.message });
    return { rows: [], recommendation: _defaultRecommendation() };
  }
}

/** Backward-compatibility shim – always returns true. */
function canStart() { return true; }

/** Backward-compatibility shim – no-op. */
function loadRules() {}

/** Backward-compatibility shim – returns empty array. */
function getRules() { return []; }

module.exports = {
  recordDownload,
  getRecommendedTime,
  shouldAutoSchedule,
  scheduleLargeDownload,
  getScheduleData,
  canStart,
  loadRules,
  getRules,
};
