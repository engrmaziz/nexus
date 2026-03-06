'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const { XMLParser } = require('fast-xml-parser');
const pLimit = require('../utils/pLimit');
const MergeEngine = require('./mergeEngine');
const SpeedTracker = require('./speedTracker');
const logger = require('../utils/logger');

const VIDEO_CONCURRENCY = 8;
const AUDIO_CONCURRENCY = 8;
const SEGMENT_RETRIES   = 3;
const FETCH_TIMEOUT     = 20_000;
/**
 * Maximum number of segments to generate when using a $Number$-based
 * SegmentTemplate without a SegmentTimeline. Segments returning HTTP 404
 * are silently skipped, so this cap limits worst-case requests.
 */
const MAX_TEMPLATE_SEGMENTS = 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveUrl(uri, base) {
  if (/^https?:\/\//i.test(uri)) return uri;
  const b = new URL(base);
  if (uri.startsWith('//')) return `${b.protocol}${uri}`;
  if (uri.startsWith('/')) return `${b.protocol}//${b.host}${uri}`;
  const dir = b.pathname.split('/').slice(0, -1).join('/');
  return `${b.protocol}//${b.host}${dir}/${uri}`;
}

function fetchText(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(
      url,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusDownloader/1.0)', ...extraHeaders },
        timeout: FETCH_TIMEOUT,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchText(res.headers.location, extraHeaders));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
        res.on('error', reject);
      }
    ).on('error', reject)
     .on('timeout', function () { this.destroy(new Error(`Timeout fetching ${url}`)); });
  });
}

async function fetchBuffer(url, extraHeaders = {}, retries = SEGMENT_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await _fetchBufferOnce(url, extraHeaders);
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = 500 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function _fetchBufferOnce(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(
      url,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusDownloader/1.0)', ...extraHeaders },
        timeout: FETCH_TIMEOUT,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(_fetchBufferOnce(res.headers.location, extraHeaders));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        const bufs = [];
        res.on('data', (c) => bufs.push(c));
        res.on('end', () => resolve(Buffer.concat(bufs)));
        res.on('error', reject);
      }
    ).on('error', reject)
     .on('timeout', function () { this.destroy(new Error(`Timeout fetching ${url}`)); });
  });
}

// ─── MPD Parser ───────────────────────────────────────────────────────────────

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['Period', 'AdaptationSet', 'Representation', 'SegmentURL', 'S'].includes(name),
});

/**
 * Parse an MPD XML document and extract segment URLs.
 * Returns: { videoSegments: string[], audioSegments: string[] }
 */
function parseMpd(mpdText, mpdUrl, requestedHeight = null) {
  const doc = XML_PARSER.parse(mpdText);
  const mpd = doc.MPD || {};
  const periods = Array.isArray(mpd.Period) ? mpd.Period : [mpd.Period].filter(Boolean);

  if (!periods.length) throw new Error('No Period found in MPD');

  const period = periods[0];
  const adaptations = Array.isArray(period.AdaptationSet)
    ? period.AdaptationSet
    : [period.AdaptationSet].filter(Boolean);

  const videoAdaptations = adaptations.filter(
    (a) => (a['@_contentType'] || a['@_mimeType'] || '').includes('video')
  );
  const audioAdaptations = adaptations.filter(
    (a) => (a['@_contentType'] || a['@_mimeType'] || '').includes('audio')
  );

  // If no explicit content type, use codecs
  const allAdaptations = videoAdaptations.length === 0 && audioAdaptations.length === 0
    ? adaptations
    : null;

  const videoSegs  = _extractSegments(videoAdaptations.length ? videoAdaptations : adaptations.slice(0, 1), mpdUrl, requestedHeight);
  const audioSegs  = _extractSegments(audioAdaptations, mpdUrl, null);

  return { videoSegments: videoSegs, audioSegments: audioSegs };
}

function _extractSegments(adaptations, mpdUrl, requestedHeight) {
  if (!adaptations || !adaptations.length) return [];

  // Pick best representation (highest bandwidth that fits requested height)
  let bestRep = null;
  let bestBandwidth = 0;

  for (const adaptation of adaptations) {
    const reps = Array.isArray(adaptation.Representation)
      ? adaptation.Representation
      : [adaptation.Representation].filter(Boolean);

    for (const rep of reps) {
      const bw = parseInt(rep['@_bandwidth'] || '0', 10);
      const h = parseInt(rep['@_height'] || '0', 10);

      if (requestedHeight && h > requestedHeight + 20) continue;

      if (bw > bestBandwidth || !bestRep) {
        bestBandwidth = bw;
        bestRep = { rep, adaptation };
      }
    }
  }

  if (!bestRep) return [];

  const { rep, adaptation } = bestRep;
  const baseUrl = _getBaseUrl(rep, adaptation, mpdUrl);

  // SegmentList
  if (rep.SegmentList || adaptation.SegmentList) {
    const sl = rep.SegmentList || adaptation.SegmentList;
    const urls = Array.isArray(sl.SegmentURL)
      ? sl.SegmentURL
      : [sl.SegmentURL].filter(Boolean);

    return urls.map((su) => resolveUrl(su['@_media'] || su['@_mediaRange'] || '', baseUrl));
  }

  // SegmentTemplate with $Number$ or $Time$
  const template = rep.SegmentTemplate || adaptation.SegmentTemplate;
  if (template) {
    const media = template['@_media'] || '';
    const initAttr = template['@_initialization'] || '';
    const startNum = parseInt(template['@_startNumber'] || '1', 10);
    const timescale = parseInt(template['@_timescale'] || '1', 10);
    const duration = parseInt(template['@_duration'] || '0', 10);

    const segs = [];

    if (initAttr) {
      const initUrl = initAttr
        .replace('$RepresentationID$', rep['@_id'] || '')
        .replace('$Bandwidth$', rep['@_bandwidth'] || '');
      segs.push(resolveUrl(initUrl, baseUrl));
    }

    // SegmentTimeline
    if (template.SegmentTimeline) {
      const ss = Array.isArray(template.SegmentTimeline.S)
        ? template.SegmentTimeline.S
        : [template.SegmentTimeline.S].filter(Boolean);

      let number = startNum;
      let time = 0;
      for (const s of ss) {
        if (s['@_t'] !== undefined) time = parseInt(s['@_t'], 10);
        const repeat = parseInt(s['@_r'] || '0', 10) + 1;
        const segDuration = parseInt(s['@_d'], 10);

        for (let i = 0; i < repeat; i++) {
          const segUrl = media
            .replace('$RepresentationID$', rep['@_id'] || '')
            .replace('$Bandwidth$', rep['@_bandwidth'] || '')
            .replace('$Number$', String(number))
            .replace('$Time$', String(time));
          segs.push(resolveUrl(segUrl, baseUrl));
          number++;
          time += segDuration;
        }
      }
    } else if (duration > 0) {
      // Use mediaPresentationDuration to figure out count
      // Approximate: just generate 1000 segments and stop at 404 (handled in download)
      for (let i = startNum; i < startNum + MAX_TEMPLATE_SEGMENTS; i++) {
        const segUrl = media
          .replace('$RepresentationID$', rep['@_id'] || '')
          .replace('$Bandwidth$', rep['@_bandwidth'] || '')
          .replace('$Number$', String(i));
        segs.push(resolveUrl(segUrl, baseUrl));
      }
    }

    return segs;
  }

  // No recognised segment scheme – try base URL as a single file
  return baseUrl ? [baseUrl] : [];
}

function _getBaseUrl(rep, adaptation, mpdUrl) {
  // Prefer explicit BaseURL element, then fall back to MPD location
  const repBase = rep.BaseURL;
  const adaptBase = adaptation.BaseURL;
  if (repBase) return resolveUrl(String(repBase), mpdUrl);
  if (adaptBase) return resolveUrl(String(adaptBase), mpdUrl);
  return mpdUrl;
}

// ─── DashEngine ───────────────────────────────────────────────────────────────

/**
 * DashEngine – downloads a DASH/MPD adaptive stream.
 *
 * Emits: 'progress' { downloaded, total, speed, progress, eta }
 *        'complete'
 *        'error'
 */
class DashEngine extends EventEmitter {
  /**
   * @param {object}  opts
   * @param {string}  opts.url          MPD manifest URL.
   * @param {string}  opts.outputFile
   * @param {string}  opts.tempDir
   * @param {object}  [opts.headers]
   * @param {string}  [opts.quality]    e.g. '1080p' – restricts max height.
   */
  constructor(opts) {
    super();
    this.url = opts.url;
    this.outputFile = opts.outputFile;
    this.tempDir = opts.tempDir;
    this.headers = opts.headers || {};
    this.quality = opts.quality || 'best';
    this._aborted = false;
    this._paused = false;
    this.speedTracker = new SpeedTracker();
  }

  async start() {
    try {
      await fs.promises.mkdir(this.tempDir, { recursive: true });

      // 1. Fetch and parse MPD
      const mpdText = await fetchText(this.url, this.headers);
      const requestedHeight = this._parseQualityHeight();
      const { videoSegments, audioSegments } = parseMpd(mpdText, this.url, requestedHeight);

      if (!videoSegments.length) throw new Error('No video segments found in DASH manifest');

      const total = videoSegments.length + audioSegments.length;
      let done = 0;

      const onSegment = (bytes) => {
        done++;
        this.speedTracker.addSample(bytes);
        const speed = this.speedTracker.getSpeed();
        const progress = total > 0 ? Math.min(100, (done / total) * 100) : 0;
        this.emit('progress', { downloaded: done, total, speed, progress, eta: 0 });
      };

      // 2. Download video segments
      const videoDir = path.join(this.tempDir, 'video');
      await fs.promises.mkdir(videoDir, { recursive: true });
      await this._downloadSegments(videoSegments, videoDir, onSegment, VIDEO_CONCURRENCY);

      // 3. Download audio segments
      const audioDir = path.join(this.tempDir, 'audio');
      let hasAudio = audioSegments.length > 0;
      if (hasAudio) {
        await fs.promises.mkdir(audioDir, { recursive: true });
        await this._downloadSegments(audioSegments, audioDir, onSegment, AUDIO_CONCURRENCY);
      }

      // 4. Concatenate each track
      const videoFile = path.join(this.tempDir, 'video_combined.mp4');
      const audioFile = path.join(this.tempDir, 'audio_combined.m4a');
      const merger = new MergeEngine();

      await this._concatDir(videoDir, videoFile);
      if (hasAudio) await this._concatDir(audioDir, audioFile);

      // 5. Merge video + audio
      if (hasAudio) {
        await merger.mergeAudioVideo(videoFile, audioFile, this.outputFile);
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

  // ─── Internals ────────────────────────────────────────────────────────

  _parseQualityHeight() {
    if (!this.quality || this.quality === 'best') return null;
    const m = /(\d+)p/.exec(this.quality);
    return m ? parseInt(m[1], 10) : null;
  }

  async _downloadSegments(urls, dir, onSegment, concurrency) {
    const limit = pLimit(concurrency);
    const tasks = urls.map((url, idx) =>
      limit(async () => {
        if (this._aborted) return;
        while (this._paused && !this._aborted) await new Promise((r) => setTimeout(r, 300));
        if (this._aborted) return;

        const ext = path.extname(new URL(url).pathname) || '.m4s';
        const outFile = path.join(dir, `seg_${String(idx).padStart(6, '0')}${ext}`);

        if (fs.existsSync(outFile)) {
          onSegment(0);
          return;
        }

        let buf;
        try {
          buf = await fetchBuffer(url, this.headers);
        } catch (err) {
          // For template-based streams we might generate too many segments
          if (err.message.includes('HTTP 404')) return;
          throw err;
        }

        fs.writeFileSync(outFile, buf);
        onSegment(buf.length);
      })
    );

    await Promise.all(tasks);
  }

  async _concatDir(dir, outFile) {
    const files = fs.readdirSync(dir)
      .filter((f) => /\.(m4s|mp4|ts|m4a|aac)$/.test(f))
      .sort()
      .map((f) => path.join(dir, f));

    if (files.length === 0) throw new Error(`No segment files in ${dir}`);

    const merger = new MergeEngine();
    await merger.concatSegments(files, outFile);
  }

  _cleanup() {
    try {
      const dirs = [
        path.join(this.tempDir, 'video'),
        path.join(this.tempDir, 'audio'),
      ];
      for (const d of dirs) {
        if (!fs.existsSync(d)) continue;
        for (const f of fs.readdirSync(d)) {
          try { fs.unlinkSync(path.join(d, f)); } catch (_) {}
        }
        try { fs.rmdirSync(d); } catch (_) {}
      }
      const tmpFiles = ['video_combined.mp4', 'audio_combined.m4a'];
      for (const f of tmpFiles) {
        const fp = path.join(this.tempDir, f);
        if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) {} }
      }
    } catch (_) {}
  }
}

module.exports = DashEngine;
