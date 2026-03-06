'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const { parse: parseMpd } = require('mpd-parser');
const MergeEngine = require('./mergeEngine');
const SpeedTracker = require('./speedTracker');
const logger = require('../utils/logger');

/**
 * DashEngine – downloads a DASH (MPD) adaptive stream.
 *
 * Strategy:
 *  1. Fetch and parse the MPD manifest.
 *  2. Pick the highest-quality video and audio AdaptationSets.
 *  3. Download all segments in parallel (bounded concurrency).
 *  4. Merge video + audio with FFmpeg.
 *
 * Emits: 'progress', 'complete', 'error'
 */
class DashEngine extends EventEmitter {
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
  }

  async start() {
    try {
      const mpdText = await this._fetchText(this.url);
      const parsed = parseMpd(mpdText, { manifestUri: this.url });

      const videoPlaylist = this._pickBestVideoPlaylist(parsed);
      const audioPlaylist = this._pickBestAudioPlaylist(parsed);

      if (!videoPlaylist) throw new Error('No video stream found in DASH manifest');

      const videoSegments = this._getSegments(videoPlaylist);
      const audioSegments = audioPlaylist ? this._getSegments(audioPlaylist) : [];

      const total = videoSegments.length + audioSegments.length;
      let done = 0;

      const updateProgress = (bytes) => {
        done++;
        this.speedTracker.update(bytes);
        this.emit('progress', {
          downloaded: done,
          total,
          speed: this.speedTracker.getSpeed(),
          progress: total > 0 ? Math.min(100, (done / total) * 100) : 0,
        });
      };

      // Download video segments
      const videoDir = path.join(this.tempDir, 'video');
      fs.mkdirSync(videoDir, { recursive: true });
      await this._downloadSegments(videoSegments, videoDir, updateProgress);

      // Download audio segments
      const audioDir = path.join(this.tempDir, 'audio');
      if (audioSegments.length > 0) {
        fs.mkdirSync(audioDir, { recursive: true });
        await this._downloadSegments(audioSegments, audioDir, updateProgress);
      }

      // Concatenate segments for each track
      const videoFile = path.join(this.tempDir, 'video_combined.mp4');
      const audioFile = path.join(this.tempDir, 'audio_combined.mp4');

      await this._concatSegments(videoDir, videoFile);
      if (audioSegments.length > 0) {
        await this._concatSegments(audioDir, audioFile);
      }

      // Merge video + audio
      const merger = new MergeEngine();
      if (audioSegments.length > 0) {
        await merger.mergeVideoAudio(videoFile, audioFile, this.outputFile);
      } else {
        fs.renameSync(videoFile, this.outputFile);
      }

      this._cleanup();
      this.emit('complete');
    } catch (err) {
      if (!this._aborted) this.emit('error', err);
    }
  }

  pause() { this._paused = true; }
  resume() { this._paused = false; }
  abort() { this._aborted = true; this._paused = true; }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  _pickBestVideoPlaylist(parsed) {
    const playlists = parsed.playlists || [];
    const video = playlists.filter(
      (p) => p.attributes && p.attributes.CODECS && !p.attributes.CODECS.startsWith('mp4a')
    );
    if (video.length === 0) return playlists[0] || null;
    return video.sort(
      (a, b) => (b.attributes.BANDWIDTH || 0) - (a.attributes.BANDWIDTH || 0)
    )[0];
  }

  _pickBestAudioPlaylist(parsed) {
    const mediaGroups = parsed.mediaGroups?.AUDIO;
    if (!mediaGroups) return null;
    for (const groupId of Object.keys(mediaGroups)) {
      for (const lang of Object.keys(mediaGroups[groupId])) {
        const track = mediaGroups[groupId][lang];
        if (track.playlists && track.playlists.length > 0) {
          return track.playlists[0];
        }
      }
    }
    return null;
  }

  _getSegments(playlist) {
    return (playlist.segments || []).map((s) => s.resolvedUri || s.uri);
  }

  async _downloadSegments(urls, dir, onSegment) {
    const batches = [];
    for (let i = 0; i < urls.length; i += this.concurrency) {
      batches.push(urls.slice(i, i + this.concurrency));
    }

    let idx = 0;
    for (const batch of batches) {
      if (this._aborted) return;
      while (this._paused && !this._aborted) await new Promise((r) => setTimeout(r, 300));

      await Promise.all(
        batch.map(async (url) => {
          const localIdx = idx++;
          const outFile = path.join(dir, `seg_${String(localIdx).padStart(6, '0')}.m4s`);
          if (fs.existsSync(outFile)) { onSegment(0); return; }
          const buf = await this._fetchBuffer(url);
          fs.writeFileSync(outFile, buf);
          onSegment(buf.length);
        })
      );
    }
  }

  async _concatSegments(dir, outFile) {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.m4s') || f.endsWith('.mp4'))
      .sort()
      .map((f) => path.join(dir, f));

    const ws = fs.createWriteStream(outFile);
    for (const f of files) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(f);
        rs.pipe(ws, { end: false });
        rs.on('end', resolve);
        rs.on('error', reject);
      });
    }
    await new Promise((resolve) => ws.end(resolve));
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

  _cleanup() {
    try {
      const dirs = ['video', 'audio'].map((d) => path.join(this.tempDir, d));
      for (const dir of dirs) {
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
          }
          try { fs.rmdirSync(dir); } catch (_) {}
        }
      }
      const tmpFiles = ['video_combined.mp4', 'audio_combined.mp4'];
      for (const f of tmpFiles) {
        const fp = path.join(this.tempDir, f);
        if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch (_) {}
      }
    } catch (_) {}
  }
}

module.exports = DashEngine;
