'use strict';

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const logger = require('../utils/logger');

// ─── Binary path ──────────────────────────────────────────────────────────────

const BIN_DIR = path.join(
  process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
  'bin'
);

const YTDLP_BIN = process.env.YTDLP_BIN || path.join(
  BIN_DIR,
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

// GitHub releases API for latest yt-dlp
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

// Regex to parse yt-dlp download progress lines:
// [download]  45.3% of ~  234.12MiB at    5.23MiB/s ETA 00:33
const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\S+)\s+at\s+([\d.]+\s*\S+\/s)\s+ETA\s+([\d:]+)/;

// Format selection map
const QUALITY_MAP = {
  best:  'bestvideo+bestaudio/best',
  '4k':  'bestvideo[height<=2160]+bestaudio/best[height<=2160]',
  '1080p': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  '720p':  'bestvideo[height<=720]+bestaudio/best[height<=720]',
  '480p':  'bestvideo[height<=480]+bestaudio/best[height<=480]',
  '360p':  'bestvideo[height<=360]+bestaudio/best[height<=360]',
  audio:   'bestaudio/best',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run yt-dlp with the given args.
 * @param {string[]} args
 * @param {object}   [opts]
 * @param {boolean}  [opts.capture]       Capture stdout and return it.
 * @param {Function} [opts.onProgress]    Called with parsed progress objects.
 * @param {Function} [opts.onStdoutLine]  Called with each raw stdout line.
 * @param {AbortSignal} [opts.signal]     AbortSignal for cancellation.
 * @param {Function} [opts.onProc]        Called with the spawned child process.
 * @returns {Promise<string>}  Resolves to captured stdout (if capture=true) or ''.
 */
function runYtdlp(args, opts = {}) {
  const { capture = false, onProgress, onStdoutLine, signal, onProc } = opts;

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(YTDLP_BIN)) {
      return reject(new Error(`yt-dlp binary not found at ${YTDLP_BIN}. Call installYtdlp() first.`));
    }

    logger.debug('yt-dlp spawn', { args });

    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    if (typeof onProc === 'function') onProc(proc);

    let stdout = '';
    let stderr = '';

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk) => {
      if (capture) {
        stdout += chunk;
        return;
      }
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (typeof onStdoutLine === 'function') onStdoutLine(line);

        const m = PROGRESS_RE.exec(line);
        if (m && typeof onProgress === 'function') {
          onProgress({
            percent: parseFloat(m[1]),
            size: m[2].trim(),
            speed: m[3].trim(),
            eta: m[4].trim(),
          });
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        try {
          if (process.platform === 'win32') {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
          } else {
            proc.kill('SIGKILL');
          }
        } catch (_) {}
      });
    }

    proc.on('close', (code) => {
      if (signal && signal.aborted) return resolve('');
      if (code === 0) {
        resolve(capture ? stdout.trim() : '');
      } else {
        const errMsg = _mapYtdlpError(stderr, code);
        reject(new Error(errMsg));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });
  });
}

/**
 * Map yt-dlp stderr + exit code to a user-friendly error message.
 */
function _mapYtdlpError(stderr, code) {
  const s = stderr.toLowerCase();
  if (s.includes('video unavailable') || s.includes('not available'))
    return 'Video is unavailable or has been removed.';
  if (s.includes('private video') || s.includes('sign in'))
    return 'This video is private or requires authentication.';
  if (s.includes('age')) return 'Age-restricted content. Authentication required.';
  if (s.includes('copyright') || s.includes('blocked'))
    return 'This content is geo-restricted or blocked by copyright.';
  if (s.includes('no such file') || s.includes('not found'))
    return 'yt-dlp binary not found or the requested file does not exist.';
  return `yt-dlp exited with code ${code}: ${stderr.slice(-400)}`;
}

// ─── Exported functions ───────────────────────────────────────────────────────

/**
 * Fetch metadata for a video URL without downloading it.
 *
 * @param {string} url
 * @returns {Promise<{title,thumbnail,duration,uploader,formats,is_live,playlist_count}>}
 */
async function getVideoInfo(url) {
  const raw = await runYtdlp(['--dump-json', '--no-download', '--no-playlist', url], { capture: true });
  let info;
  try {
    info = JSON.parse(raw);
  } catch (_) {
    throw new Error('Failed to parse yt-dlp info JSON');
  }
  return {
    title: info.title || '',
    thumbnail: info.thumbnail || '',
    duration: info.duration || 0,
    uploader: info.uploader || info.channel || '',
    formats: info.formats || [],
    is_live: !!info.is_live,
    playlist_count: info.playlist_count || 1,
    _raw: info,
  };
}

/**
 * Fetch flat playlist info (no video download).
 *
 * @param {string} url
 * @returns {Promise<{title, entries, count}>}
 */
async function getPlaylistInfo(url) {
  const raw = await runYtdlp(
    ['--flat-playlist', '--dump-single-json', url],
    { capture: true }
  );
  let info;
  try {
    info = JSON.parse(raw);
  } catch (_) {
    throw new Error('Failed to parse yt-dlp playlist JSON');
  }
  const entries = (info.entries || []).map((e) => ({
    id: e.id || '',
    title: e.title || '',
    url: e.url || e.webpage_url || '',
    duration: e.duration || 0,
    thumbnail: e.thumbnail || '',
  }));
  return {
    title: info.title || '',
    entries,
    count: info.playlist_count || entries.length,
  };
}

/**
 * Download a video from `url`.
 *
 * @param {string}   url
 * @param {string}   quality   'best' | '1080p' | '720p' | '480p' | '360p' | 'audio'
 * @param {string}   outputPath  Output file path (with extension).
 * @param {Function} onProgress  Called with { percent, size, speed, eta }.
 * @param {object}   [opts]
 * @param {string}   [opts.cookies]    Path to Netscape cookies file.
 * @param {string}   [opts.proxy]
 * @param {string}   [opts.rateLimit]  e.g. '2M'
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>}  Resolves to outputPath.
 */
async function downloadVideo(url, quality, outputPath, onProgress, opts = {}) {
  const format = QUALITY_MAP[quality] || QUALITY_MAP.best;

  const args = [
    '-f', format,
    '--merge-output-format', 'mp4',
    '-o', outputPath,
    '--newline',
    '--no-part',
    '--write-subs',
    '--sub-langs', 'en,auto',
    '--embed-subs',
    '--write-thumbnail',
    '--embed-thumbnail',
    '--retries', '5',
    '--fragment-retries', '5',
  ];

  if (opts.cookies) args.push('--cookies', opts.cookies);
  if (opts.proxy)   args.push('--proxy', opts.proxy);
  if (opts.rateLimit) args.push('--rate-limit', opts.rateLimit);

  args.push(url);

  await runYtdlp(args, {
    onProgress,
    onStdoutLine: opts.onStdoutLine,
    signal: opts.signal,
    onProc: opts.onProc,
  });
  return outputPath;
}

/**
 * List available formats for a URL.
 *
 * @param {string} url
 * @returns {Promise<object[]>}  Array of format objects with quality labels.
 */
async function getAvailableFormats(url) {
  // Use --dump-json to get format list
  const raw = await runYtdlp(['--dump-json', '--no-download', '--no-playlist', url], { capture: true });
  let info;
  try {
    info = JSON.parse(raw);
  } catch (_) {
    throw new Error('Failed to parse format info JSON');
  }

  const formats = (info.formats || []).filter((f) => f.vcodec !== 'none' || f.acodec !== 'none');

  // Build labelled best options
  const qualityLabels = [
    { label: '4K',      height: 2160 },
    { label: '1080p60', height: 1080, fps: 60 },
    { label: '1080p',   height: 1080 },
    { label: '720p60',  height: 720,  fps: 60 },
    { label: '720p',    height: 720 },
    { label: '480p',    height: 480 },
    { label: '360p',    height: 360 },
    { label: 'Audio',   audio: true },
  ];

  const result = [];

  for (const ql of qualityLabels) {
    if (ql.audio) {
      const af = formats
        .filter((f) => f.vcodec === 'none' && f.acodec !== 'none')
        .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
      if (af) {
        result.push({
          label: 'Audio only',
          quality: 'audio',
          format_id: af.format_id,
          ext: af.ext,
          abr: af.abr,
          filesize: af.filesize,
        });
      }
    } else {
      const vf = formats
        .filter((f) => {
          if (f.vcodec === 'none') return false;
          if (f.height && f.height > ql.height + 10) return false;
          if (ql.fps && f.fps < ql.fps - 5) return false;
          return true;
        })
        .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))[0];

      if (vf && !result.some((r) => r.format_id === vf.format_id)) {
        result.push({
          label: ql.label,
          quality: `${ql.height}p`,
          format_id: vf.format_id,
          ext: vf.ext,
          height: vf.height,
          fps: vf.fps,
          vcodec: vf.vcodec,
          filesize: vf.filesize,
        });
      }
    }
  }

  return result;
}

/**
 * Check whether the yt-dlp binary exists and is executable.
 * @returns {boolean}
 */
function ytdlpInstalled() {
  if (!fs.existsSync(YTDLP_BIN)) return false;
  try {
    fs.accessSync(YTDLP_BIN, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Download and install the latest yt-dlp binary.
 *
 * Determines the correct asset for the current platform, downloads it to
 * `~/.nexus/bin/`, and makes it executable on Unix.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.onProgress]  ({ percent, bytesDownloaded, totalBytes })
 * @returns {Promise<string>}  Resolves to the installed binary path.
 */
async function installYtdlp(opts = {}) {
  const { onProgress } = opts;

  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  // Determine asset name
  let assetName;
  switch (process.platform) {
    case 'win32':   assetName = 'yt-dlp.exe'; break;
    case 'darwin':  assetName = 'yt-dlp_macos'; break;
    default:        assetName = 'yt-dlp';
  }

  // Fetch latest release info
  const releaseInfo = await fetchJson(GITHUB_RELEASES_URL);
  const asset = (releaseInfo.assets || []).find((a) => a.name === assetName);

  if (!asset) {
    throw new Error(`yt-dlp asset '${assetName}' not found in latest GitHub release.`);
  }

  const downloadUrl = asset.browser_download_url;
  logger.info('Installing yt-dlp', { url: downloadUrl, dest: YTDLP_BIN });

  await downloadFile(downloadUrl, YTDLP_BIN, onProgress);

  // Make executable on Unix
  if (process.platform !== 'win32') {
    fs.chmodSync(YTDLP_BIN, 0o755);
  }

  logger.info('yt-dlp installed', { path: YTDLP_BIN });
  return YTDLP_BIN;
}

// ─── Internals ────────────────────────────────────────────────────────────────

/** Fetch a URL as JSON. Follows up to 5 redirects. */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(
      url,
      {
        headers: {
          'User-Agent': 'NexusDownloader/1.0',
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return fetchJson(res.headers.location).then(resolve, reject);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
        res.on('error', reject);
      }
    ).on('error', reject);
  });
}

/** Download a binary file, following redirects, reporting progress. */
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'NexusDownloader/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download yt-dlp: HTTP ${res.statusCode}`));
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let bytesDownloaded = 0;
      const ws = fs.createWriteStream(dest);

      res.on('data', (buf) => {
        bytesDownloaded += buf.length;
        if (typeof onProgress === 'function') {
          onProgress({
            percent: totalBytes > 0 ? (bytesDownloaded / totalBytes) * 100 : 0,
            bytesDownloaded,
            totalBytes,
          });
        }
      });

      res.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Legacy class wrapper (backward compatibility) ────────────────────────────

class YtdlpEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.url = opts.url;
    this.outputDir = opts.outputDir;
    this.outputTemplate = opts.outputTemplate || '%(title)s.%(ext)s';
    this.format = opts.format || 'bestvideo+bestaudio/best';
    this.quality = opts.quality || null;
    this.subtitles = opts.subtitles || false;
    this.subtitleLangs = opts.subtitleLangs || ['en'];
    this.cookies = opts.cookies || null;
    this.rateLimit = opts.rateLimit || null;
    this.proxy = opts.proxy || null;
    this.extraArgs = opts.extraArgs || [];
    this._controller = new AbortController();
    this._aborted = false;
    this._proc = null;
  }

  async getInfo() {
    return getVideoInfo(this.url);
  }

  async listFormats() {
    return getAvailableFormats(this.url);
  }

  async download() {
    // Fetch the real video title before starting the download
    let realTitle = null;
    try {
      realTitle = (await runYtdlp(['--get-title', '--no-playlist', this.url], { capture: true })).trim();
    } catch (_) {}

    if (realTitle) {
      this.emit('title', realTitle);
      this.emit('progress', { percent: 0, title: realTitle, speed: '0', eta: '--' });
    }

    const outputDir = this.outputDir;
    const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s');
    const quality = this.quality || 'best';

    // Patterns to capture the actual output filename from yt-dlp stdout
    const MERGER_RE      = /\[Merger\] Merging formats into "(.+)"$/;
    const DESTINATION_RE = /\[download\] Destination: (.+)$/;
    const FFMPEG_RE      = /\[ffmpeg\] .+ in (.+\.\w{2,6})$/;

    let resolvedFilename = null;

    const onStdoutLine = (line) => {
      const l = line.trim();
      let m;
      if ((m = MERGER_RE.exec(l))) {
        resolvedFilename = m[1];
      } else if ((m = DESTINATION_RE.exec(l))) {
        resolvedFilename = m[1];
      } else if ((m = FFMPEG_RE.exec(l))) {
        resolvedFilename = m[1];
      }
    };

    try {
      await downloadVideo(
        this.url,
        quality,
        outputTemplate,
        (p) => this.emit('progress', p),
        {
          cookies: this.cookies,
          proxy: this.proxy,
          rateLimit: this.rateLimit,
          signal: this._controller.signal,
          onProc: (proc) => { this._proc = proc; },
          onStdoutLine,
        }
      );

      // If no filename was captured from stdout, scan outputDir for the newest video file
      if (!resolvedFilename) {
        try {
          const files = fs.readdirSync(outputDir)
            .filter((f) => ['.mp4', '.mkv', '.webm'].includes(path.extname(f).toLowerCase()))
            .map((f) => ({ f, t: fs.statSync(path.join(outputDir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
          if (files.length > 0) {
            resolvedFilename = files[0].f;
          }
        } catch (scanErr) {
          logger.debug('ytdlpEngine: directory scan for output file failed', { err: scanErr.message });
        }
      }

      if (resolvedFilename) {
        // Ensure it is an absolute path
        const realFilePath = path.isAbsolute(resolvedFilename)
          ? resolvedFilename
          : path.join(outputDir, resolvedFilename);
        this.emit('filename', realFilePath);
      }

      this.emit('complete', { outputPath: outputTemplate });
    } catch (err) {
      this.emit('error', err);
      throw err;
    }
  }

  abort() {
    this._aborted = true;
    this._controller.abort();
    if (this._proc) {
      try {
        if (process.platform === 'win32') {
          const { execFile } = require('child_process');
          execFile('taskkill', ['/pid', String(this._proc.pid), '/T', '/F']);
        } else {
          this._proc.kill('SIGKILL');
        }
      } catch (_) {}
      this._proc = null;
    }
  }

  static getBinaryPath() {
    return YTDLP_BIN;
  }
}

module.exports = YtdlpEngine;
module.exports.getVideoInfo = getVideoInfo;
module.exports.getPlaylistInfo = getPlaylistInfo;
module.exports.downloadVideo = downloadVideo;
module.exports.getAvailableFormats = getAvailableFormats;
module.exports.ytdlpInstalled = ytdlpInstalled;
module.exports.installYtdlp = installYtdlp;
module.exports.YTDLP_BIN = YTDLP_BIN;
