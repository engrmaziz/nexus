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

/**
 * Global unhandled promise rejection handler – log and continue.
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

module.exports = { NexusError, CODES, classify, wrap, registerGlobalHandlers };
