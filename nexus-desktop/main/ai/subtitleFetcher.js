'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const logger = require('../utils/logger');

// ─── yt-dlp binary path ────────────────────────────────────────────────────────

function _getYtdlpBin() {
  try {
    const YtdlpEngine = require('../engine/ytdlpEngine');
    return YtdlpEngine.YTDLP_BIN || _defaultBin();
  } catch (_) {
    return _defaultBin();
  }
}

function _defaultBin() {
  const os = require('os');
  const base = path.join(
    process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
    'bin'
  );
  return path.join(base, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

// ─── Core fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch subtitles for a video URL using yt-dlp.
 *
 * Never throws – subtitle errors are logged and silently swallowed so that
 * the main download is never blocked.
 *
 * @param {string}   videoUrl   Source video URL
 * @param {string}   outputDir  Directory to save .srt files
 * @param {string[]} [languages=['en']]  BCP-47 language codes
 * @returns {Promise<Array<{ language: string, path: string }>>}
 */
async function fetchSubtitles(videoUrl, outputDir, languages = ['en']) {
  const results = [];

  const ytdlpBin = _getYtdlpBin();
  if (!fs.existsSync(ytdlpBin)) {
    logger.debug('SubtitleFetcher: yt-dlp not found, skipping subtitles');
    return results;
  }

  // Ensure output directory exists
  try {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  } catch (err) {
    logger.warn('SubtitleFetcher: could not create outputDir', { err: err.message });
    return results;
  }

  const langStr = languages.join(',');

  const args = [
    '--write-subs',
    '--write-auto-subs',
    '--skip-download',
    '--sub-langs', langStr,
    '--convert-subs', 'srt',
    '--output', path.join(outputDir, '%(title)s.%(ext)s'),
    videoUrl,
  ];

  try {
    await _runYtdlp(ytdlpBin, args);
  } catch (err) {
    // yt-dlp returned non-zero – it may simply mean no subs are available
    logger.debug('SubtitleFetcher: yt-dlp returned error (no subs or unsupported)', { err: err.message });
    return results;
  }

  // Discover .srt files written to the output dir
  try {
    const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.srt'));
    for (const file of files) {
      // Attempt to map the file to a language code
      const lang = _detectLang(file, languages);
      results.push({ language: lang, path: path.join(outputDir, file) });
    }
  } catch (err) {
    logger.warn('SubtitleFetcher: error reading outputDir', { err: err.message });
  }

  if (results.length > 0) {
    const langNames = results.map((r) => r.language).join(', ');
    logger.info(`SubtitleFetcher: subtitles downloaded: ${langNames}`);
    _showNotification(`Subtitles downloaded: ${langNames}`);
  }

  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run yt-dlp with the given args.
 * Resolves on exit code 0, rejects otherwise.
 */
function _runYtdlp(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited with code ${code}: ${stderr.slice(-200)}`));
    });
    proc.on('error', (err) => reject(new Error(`Failed to spawn yt-dlp: ${err.message}`)));
  });
}

/**
 * Attempt to detect the language from a subtitle filename.
 * yt-dlp typically names them: "Title.en.srt", "Title.es.srt"
 */
function _detectLang(filename, requestedLangs) {
  const parts = filename.replace(/\.srt$/, '').split('.');
  const lastPart = parts[parts.length - 1];
  if (lastPart && requestedLangs.includes(lastPart)) return lastPart;
  // Common two-letter code at end
  if (/^[a-z]{2,3}(-[A-Z]{2})?$/.test(lastPart)) return lastPart;
  return requestedLangs[0] || 'en';
}

/**
 * Show a desktop notification if available (Electron context).
 */
function _showNotification(body) {
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      new Notification({ title: 'Nexus', body }).show();
    }
  } catch (_) {}
}

module.exports = { fetchSubtitles };
