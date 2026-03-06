'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { Parser: M3U8Parser } = require('m3u8-parser');
const MergeEngine = require('./mergeEngine');
const SpeedTracker = require('./speedTracker');
const logger = require('../utils/logger');

/**
 * HlsEngine – downloads an HLS (m3u8) stream and optionally decrypts AES-128 segments.
 *
 * Emits: 'progress' { downloaded, total, speed, progress }, 'complete', 'error'
 */
class HlsEngine extends EventEmitter {
  constructor(opts) {
    super();
    this.url = opts.url;
    this.outputFile = opts.outputFile;
    this.tempDir = opts.tempDir;
    this.headers = opts.headers || {};
    this.concurrency = opts.concurrency || 8;
    this._aborted = false;
    this._paused = false;
    this.speedTracker = new SpeedTracker();
    this._segments = [];
    this._downloaded = 0;
    this._total = 0;
  }

  async start() {
    try {
      const manifest = await this._fetchText(this.url);
      const parser = new M3U8Parser();
      parser.push(manifest);
      parser.end();

      const parsed = parser.manifest;

      // If this is a master playlist, pick the highest-bandwidth variant
      if (parsed.playlists && parsed.playlists.length > 0) {
        const sorted = [...parsed.playlists].sort(
          (a, b) => (b.attributes.BANDWIDTH || 0) - (a.attributes.BANDWIDTH || 0)
        );
        const variantUrl = this._resolveUrl(sorted[0].uri, this.url);
        return this._downloadVariant(variantUrl, parsed.playlists[0].attributes);
      }

      await this._downloadVariant(this.url, {});
    } catch (err) {
      if (!this._aborted) this.emit('error', err);
    }
  }

  pause() { this._paused = true; }
  resume() { this._paused = false; this._processSegments().catch((e) => this.emit('error', e)); }
  abort() { this._aborted = true; this._paused = true; }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  async _downloadVariant(variantUrl, _attrs) {
    const text = await this._fetchText(variantUrl);
    const parser = new M3U8Parser();
    parser.push(text);
    parser.end();

    const manifest = parser.manifest;
    this._segments = manifest.segments || [];
    this._total = this._segments.length;

    if (this._total === 0) throw new Error('No segments found in HLS manifest');

    await this._processSegments();

    // Concatenate all segment files into the output
    const segFiles = [];
    for (let i = 0; i < this._segments.length; i++) {
      const f = path.join(this.tempDir, `seg_${i}.ts`);
      if (fs.existsSync(f)) segFiles.push(f);
    }

    // Use FFmpeg to concat + convert
    const merger = new MergeEngine();
    await merger.concatTsFiles(segFiles, this.outputFile);

    this._cleanup(segFiles);
    this.emit('complete');
  }

  async _processSegments() {
    // Process segments with bounded concurrency
    const chunks = [];
    for (let i = 0; i < this._segments.length; i += this.concurrency) {
      chunks.push(this._segments.slice(i, i + this.concurrency).map((s, j) => ({ seg: s, idx: i + j })));
    }

    for (const batch of chunks) {
      if (this._aborted) return;
      while (this._paused && !this._aborted) {
        await new Promise((r) => setTimeout(r, 500));
      }

      await Promise.all(batch.map(({ seg, idx }) => this._downloadSegment(seg, idx)));
    }
  }

  async _downloadSegment(seg, idx) {
    const segUrl = this._resolveUrl(seg.uri, this.url);
    const outFile = path.join(this.tempDir, `seg_${idx}.ts`);

    // Skip if already downloaded
    if (fs.existsSync(outFile)) {
      this._downloaded++;
      return;
    }

    let data = await this._fetchBuffer(segUrl);

    // AES-128 decryption
    if (seg.key && seg.key.method === 'AES-128') {
      data = await this._decryptSegment(data, seg.key, seg.timeline, idx);
    }

    fs.writeFileSync(outFile, data);
    this._downloaded++;
    this.speedTracker.update(data.length);

    const progress = (this._downloaded / this._total) * 100;
    this.emit('progress', {
      downloaded: this._downloaded,
      total: this._total,
      speed: this.speedTracker.getSpeed(),
      progress: Math.min(100, progress),
    });
  }

  async _decryptSegment(data, keyInfo, _timeline, segIdx) {
    const keyUrl = this._resolveUrl(keyInfo.uri, this.url);
    const keyBuf = await this._fetchBuffer(keyUrl);

    // IV: use sequence number if not specified
    const iv = keyInfo.iv
      ? Buffer.from(keyInfo.iv.replace(/^0x/i, ''), 'hex')
      : Buffer.alloc(16);

    if (!keyInfo.iv) {
      iv.writeUInt32BE(segIdx, 12);
    }

    const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  _fetchText(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      let body = '';
      mod.get(url, { headers: this.headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return resolve(this._fetchText(res.headers.location));
        }
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  _fetchBuffer(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const chunks = [];
      mod.get(url, { headers: this.headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return resolve(this._fetchBuffer(res.headers.location));
        }
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  _resolveUrl(uri, base) {
    if (/^https?:\/\//i.test(uri)) return uri;
    const baseUrl = new URL(base);
    if (uri.startsWith('/')) {
      return `${baseUrl.protocol}//${baseUrl.host}${uri}`;
    }
    const dir = baseUrl.pathname.split('/').slice(0, -1).join('/');
    return `${baseUrl.protocol}//${baseUrl.host}${dir}/${uri}`;
  }

  _cleanup(files) {
    for (const f of files) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
  }
}

module.exports = HlsEngine;
