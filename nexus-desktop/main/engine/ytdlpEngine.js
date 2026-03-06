'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const logger = require('../utils/logger');

const YTDLP_BIN = process.env.YTDLP_BIN || path.join(
  process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

// Regex to parse yt-dlp progress lines
const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)\s+ETA\s+([\d:]+)/;

/**
 * YtdlpEngine – thin wrapper around yt-dlp.
 *
 * Emits: 'progress', 'info', 'complete', 'error'
 */
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
    this.rateLimit = opts.rateLimit || null;   // e.g. '2M'
    this.proxy = opts.proxy || null;
    this.extraArgs = opts.extraArgs || [];
    this._proc = null;
    this._aborted = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch metadata/info JSON for the URL without downloading.
   * @returns {Promise<object>} info dict
   */
  async getInfo() {
    const args = ['--dump-json', '--no-playlist', this.url];
    const stdout = await this._run(args, { capture: true });
    try {
      return JSON.parse(stdout);
    } catch (_) {
      throw new Error('Failed to parse yt-dlp info JSON');
    }
  }

  /**
   * List available formats.
   * @returns {Promise<object[]>}
   */
  async listFormats() {
    const info = await this.getInfo();
    return info.formats || [];
  }

  /**
   * Start the download.
   */
  async download() {
    const args = this._buildArgs();
    return this._run(args, { capture: false });
  }

  abort() {
    this._aborted = true;
    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch (_) {}
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────

  _buildArgs() {
    const args = [];

    args.push('--newline', '--progress');

    // Format selection
    if (this.quality) {
      const heightMap = { '4k': 2160, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 };
      const h = heightMap[this.quality];
      if (h) {
        args.push('-f', `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`);
      } else {
        args.push('-f', this.format);
      }
    } else {
      args.push('-f', this.format);
    }

    // Merge output format
    args.push('--merge-output-format', 'mp4');

    // Output template
    args.push('-o', path.join(this.outputDir, this.outputTemplate));

    // Subtitles
    if (this.subtitles) {
      args.push('--write-sub', '--write-auto-sub');
      args.push('--sub-langs', this.subtitleLangs.join(','));
      args.push('--convert-subs', 'srt');
    }

    // Rate limit
    if (this.rateLimit) args.push('--rate-limit', this.rateLimit);

    // Proxy
    if (this.proxy) args.push('--proxy', this.proxy);

    // Cookies
    if (this.cookies) args.push('--cookies', this.cookies);

    // Retry
    args.push('--retries', '3', '--fragment-retries', '3');

    // Extra user args
    args.push(...this.extraArgs);

    args.push(this.url);

    return args;
  }

  _run(args, { capture }) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(YTDLP_BIN)) {
        return reject(new Error(`yt-dlp binary not found at ${YTDLP_BIN}. Run installer first.`));
      }

      logger.debug('yt-dlp spawn', { bin: YTDLP_BIN, args });

      this._proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';

      this._proc.stdout.setEncoding('utf8');
      this._proc.stderr.setEncoding('utf8');

      this._proc.stdout.on('data', (chunk) => {
        if (capture) { stdout += chunk; return; }

        const lines = chunk.split('\n');
        for (const line of lines) {
          const m = PROGRESS_RE.exec(line);
          if (m) {
            this.emit('progress', {
              percent: parseFloat(m[1]),
              size: m[2],
              speed: m[3],
              eta: m[4],
            });
          } else if (line.startsWith('[info]')) {
            this.emit('info', line);
          }
        }
      });

      this._proc.stderr.on('data', (chunk) => {
        stderr += chunk;
      });

      this._proc.on('close', (code) => {
        this._proc = null;
        if (this._aborted) {
          return resolve(null);
        }
        if (code === 0) {
          if (capture) resolve(stdout.trim());
          else {
            this.emit('complete');
            resolve();
          }
        } else {
          const err = new Error(`yt-dlp exited with code ${code}: ${stderr.slice(-500)}`);
          this.emit('error', err);
          reject(err);
        }
      });

      this._proc.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });
    });
  }

  /**
   * Returns the expected yt-dlp binary path so callers can check/install it.
   */
  static getBinaryPath() {
    return YTDLP_BIN;
  }
}

module.exports = YtdlpEngine;
