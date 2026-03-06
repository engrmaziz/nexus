'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');
const logger = require('./logger');

const YTDLP_DIR = path.join(
  process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
  'bin'
);

const YTDLP_BIN = path.join(
  YTDLP_DIR,
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

const GITHUB_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const YTDLP_DOWNLOAD_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';

const ASSET_MAP = {
  linux:  'yt-dlp_linux',
  darwin: 'yt-dlp_macos',
  win32:  'yt-dlp.exe',
};

/**
 * Auto-install or update yt-dlp binary.
 *
 * @param {object} [opts]
 * @param {function} [opts.onProgress]  called with (percent: number)
 * @returns {Promise<string>}  path to the binary
 */
async function install(opts = {}) {
  const { onProgress } = opts;

  if (!fs.existsSync(YTDLP_DIR)) fs.mkdirSync(YTDLP_DIR, { recursive: true });

  const assetName = ASSET_MAP[process.platform] || ASSET_MAP.linux;
  const downloadUrl = `${YTDLP_DOWNLOAD_BASE}${assetName}`;

  logger.info('Downloading yt-dlp', { url: downloadUrl, dest: YTDLP_BIN });

  await downloadFile(downloadUrl, YTDLP_BIN, onProgress);

  // Make executable on Unix
  if (process.platform !== 'win32') {
    fs.chmodSync(YTDLP_BIN, 0o755);
  }

  logger.info('yt-dlp installed', { path: YTDLP_BIN });
  return YTDLP_BIN;
}

/**
 * Check whether the installed yt-dlp binary is up-to-date.
 * @returns {Promise<{ current: string|null, latest: string, needsUpdate: boolean }>}
 */
async function checkUpdate() {
  let current = null;
  if (fs.existsSync(YTDLP_BIN)) {
    try {
      current = execSync(`"${YTDLP_BIN}" --version`, { encoding: 'utf8' }).trim();
    } catch (_) {}
  }

  let latest = null;
  try {
    const info = await fetchJson(GITHUB_API);
    latest = info.tag_name || null;
  } catch (_) {}

  const needsUpdate = !current || (latest && latest !== current);
  return { current, latest, needsUpdate };
}

/**
 * Return true if yt-dlp binary exists and is executable.
 */
function isInstalled() {
  if (!fs.existsSync(YTDLP_BIN)) return false;
  try {
    execSync(`"${YTDLP_BIN}" --version`, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Return the yt-dlp binary path.
 */
function getBinaryPath() {
  return YTDLP_BIN;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    function doDownload(downloadUrl) {
      https.get(downloadUrl, { headers: { 'User-Agent': 'NexusDownloader/1.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return doDownload(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} while downloading yt-dlp`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const ws = fs.createWriteStream(dest);

        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total > 0) {
            onProgress(Math.round((received / total) * 100));
          }
        });

        res.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    }

    doDownload(url);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'NexusDownloader/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(fetchJson(res.headers.location));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = { install, checkUpdate, isInstalled, getBinaryPath };
