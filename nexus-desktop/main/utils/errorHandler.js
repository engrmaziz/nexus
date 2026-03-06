'use strict';

const logger = require('./logger');

// ─── Error codes ──────────────────────────────────────────────────────────────

const CODES = {
  UNKNOWN:            'UNKNOWN',
  NETWORK_ERROR:      'NETWORK_ERROR',
  DOWNLOAD_FAILED:    'DOWNLOAD_FAILED',
  FILE_IO:            'FILE_IO',
  DISK_FULL:          'DISK_FULL',
  PERMISSION_DENIED:  'PERMISSION_DENIED',
  INVALID_URL:        'INVALID_URL',
  NOT_FOUND:          'NOT_FOUND',
  AUTH_REQUIRED:      'AUTH_REQUIRED',
  FFMPEG_ERROR:       'FFMPEG_ERROR',
  YTDLP_ERROR:        'YTDLP_ERROR',
  DRM_DETECTED:       'DRM_DETECTED',
  DB_ERROR:           'DB_ERROR',
  TIMEOUT:            'TIMEOUT',
  ABORT:              'ABORT',
};

/**
 * NexusError – typed application error.
 */
class NexusError extends Error {
  constructor(message, code = CODES.UNKNOWN, cause = null) {
    super(message);
    this.name = 'NexusError';
    this.code = code;
    this.cause = cause;
    if (cause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

// ─── User-friendly messages ───────────────────────────────────────────────────

/**
 * Map a raw error to a human-readable message.
 * NEVER shows raw stack traces to users.
 *
 * @param {Error|string|object} error
 * @returns {string}
 */
function getUserFriendlyMessage(error) {
  // Extract message from various error shapes
  let msg = '';
  if (error instanceof Error) {
    msg = error.message || '';
  } else if (error && typeof error === 'object' && typeof error.message === 'string') {
    msg = error.message;
  } else {
    msg = String(error || '');
  }

  const code   = (error && error.code)   ? String(error.code)   : '';
  const status = (error && error.status) ? Number(error.status) : 0;

  // Named error codes
  if (code === 'ECONNRESET'  || /ECONNRESET/i.test(msg))   return 'Connection was reset. Will retry.';
  if (code === 'ETIMEDOUT'   || /ETIMEDOUT/i.test(msg))    return 'Connection timed out. Check internet.';
  if (code === 'ENOTFOUND'   || /ENOTFOUND/i.test(msg))    return 'Cannot reach server. Check URL.';
  if (code === 'ENOSPC'      || /ENOSPC/i.test(msg))       return 'Disk is full. Free space and retry.';
  if (code === 'EACCES'      || /EACCES|EPERM/i.test(msg)) return 'Permission denied. Choose different folder.';
  if (code === 'ENOENT'      || /ENOENT/i.test(msg))       return 'File or folder not found.';
  if (code === 'ERR_ABORTED' || /ERR_ABORTED|aborted/i.test(msg)) return 'Download was cancelled.';

  // DRM
  if (/drm|widevine|clearkey|playready|encrypted/i.test(msg)) {
    return 'This content is DRM protected and cannot be downloaded.';
  }

  // FFMPEG / yt-dlp specific
  if (code === 'FFMPEG_ERROR' || /ffmpeg/i.test(msg)) {
    const detail = msg.replace(/ffmpeg/i, '').replace(/error[:!]/i, '').trim().slice(0, 120);
    return `Video processing failed: ${detail || 'unknown ffmpeg error'}`;
  }
  if (code === 'YTDLP_ERROR' || /yt-dlp|ytdlp/i.test(msg)) {
    const detail = msg.replace(/yt-dlp/gi, '').trim().slice(0, 120);
    return `Video extraction failed: ${detail || 'unknown yt-dlp error'}`;
  }

  // HTTP status codes (check message string for common patterns)
  if (status === 403 || /403|forbidden/i.test(msg))  return 'Access denied. File may need login.';
  if (status === 404 || /404|not found/i.test(msg))  return 'File not found. It may have been removed.';
  if (status === 429 || /429|rate.?limit/i.test(msg)) return 'Rate limited by server. Retrying in 60s.';
  if ((status >= 500 && status <= 503) || /50[0-3]|server error/i.test(msg))
    return 'Server error. Will retry.';

  // Generic fallback
  const shortMsg = msg.slice(0, 200);
  return shortMsg ? `Download failed: ${shortMsg}` : 'Download failed: unknown error.';
}

// ─── Log to file ──────────────────────────────────────────────────────────────

const MAX_LOG_LINES = 1000;

/**
 * Append a structured error entry to the Nexus log file.
 * Rotates the log to keep the last MAX_LOG_LINES lines.
 *
 * @param {string} context  Where the error occurred
 * @param {Error|string} error
 */
function logError(context, error) {
  const entry = {
    timestamp: new Date().toISOString(),
    context,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack || '') : '',
    platform: process.platform,
    version: process.env.npm_package_version || '1.0.0',
  };

  // Always log via Winston as well
  logger.error(entry.message, { context, stack: entry.stack });

  // Append to log file
  try {
    const fs = require('fs');
    const path = require('path');
    let logPath;
    try {
      const { app } = require('electron');
      logPath = path.join(app.getPath('logs'), 'nexus.log');
    } catch (_) {
      const os = require('os');
      logPath = path.join(
        process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
        'logs', 'nexus.log'
      );
    }

    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const line = JSON.stringify(entry) + '\n';

    // Rotate: keep last MAX_LOG_LINES lines
    if (fs.existsSync(logPath)) {
      const existing = fs.readFileSync(logPath, 'utf8');
      const lines = existing.split('\n').filter(Boolean);
      if (lines.length >= MAX_LOG_LINES) {
        const trimmed = lines.slice(-(MAX_LOG_LINES - 1)).join('\n') + '\n';
        fs.writeFileSync(logPath, trimmed, 'utf8');
      }
    }

    fs.appendFileSync(logPath, line, 'utf8');
  } catch (_) {}
}

// ─── Error classification ─────────────────────────────────────────────────────

/**
 * Classify a raw error and return a NexusError with an appropriate code.
 * @param {Error|string} err
 * @param {object} [context]  extra metadata for logging
 * @returns {NexusError}
 */
function classify(err, context = {}) {
  if (err instanceof NexusError) {
    logger.error(err.message, { code: err.code, ...context });
    return err;
  }

  const msg = err instanceof Error ? err.message : String(err);
  let code = CODES.UNKNOWN;

  if (/ENOENT|ENOTDIR/i.test(msg)) code = CODES.NOT_FOUND;
  else if (/EACCES|EPERM/i.test(msg)) code = CODES.PERMISSION_DENIED;
  else if (/ENOSPC/i.test(msg)) code = CODES.DISK_FULL;
  else if (/EIO|EROFS/i.test(msg)) code = CODES.FILE_IO;
  else if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|socket hang up/i.test(msg)) code = CODES.NETWORK_ERROR;
  else if (/timeout/i.test(msg)) code = CODES.TIMEOUT;
  else if (/ffmpeg/i.test(msg)) code = CODES.FFMPEG_ERROR;
  else if (/yt-dlp/i.test(msg)) code = CODES.YTDLP_ERROR;
  else if (/drm|widevine|clearkey/i.test(msg)) code = CODES.DRM_DETECTED;
  else if (/SQLITE/i.test(msg)) code = CODES.DB_ERROR;
  else if (/aborted?/i.test(msg)) code = CODES.ABORT;
  else if (/invalid url|ERR_INVALID_URL/i.test(msg)) code = CODES.INVALID_URL;
  else if (/401|unauthorized/i.test(msg)) code = CODES.AUTH_REQUIRED;
  else if (/404|not found/i.test(msg)) code = CODES.NOT_FOUND;

  const nexusErr = new NexusError(msg, code, err instanceof Error ? err : null);
  logger.error(msg, { code, ...context });
  return nexusErr;
}

/**
 * Wrap an async function so that any thrown error is classified and re-thrown
 * as a NexusError.
 * @param {Function} fn
 * @param {object} [context]
 * @returns {Function}
 */
function wrap(fn, context = {}) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw classify(err, context);
    }
  };
}

// ─── Global handlers ──────────────────────────────────────────────────────────

/**
 * Register process-level error handlers.
 * Also attempts to forward errors to the Electron renderer if available.
 */
function initErrorHandlers() {
  process.on('uncaughtException', (err) => {
    logError('uncaughtException', err);
    _notifyRenderer('uncaughtException', err);
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logError('unhandledRejection', err);
    _notifyRenderer('unhandledRejection', err);
  });
}

/**
 * Alias kept for backward compatibility.
 */
function registerGlobalHandlers() {
  process.on('unhandledRejection', (reason, promise) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('Unhandled promise rejection', { err: err.message, stack: err.stack });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err: err.message, stack: err.stack });
    // Don't crash for non-fatal errors
  });
}

function _notifyRenderer(type, err) {
  try {
    const { BrowserWindow } = require('electron');
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      if (!win.isDestroyed()) {
        win.webContents.send('app:error', {
          type,
          message: getUserFriendlyMessage(err),
        });
      }
    }
  } catch (_) {}
}

module.exports = {
  NexusError,
  CODES,
  classify,
  wrap,
  getUserFriendlyMessage,
  logError,
  initErrorHandlers,
  registerGlobalHandlers,
};
