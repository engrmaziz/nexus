'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const SpeedTracker = require('./speedTracker');
const resumeManager = require('./resumeManager');
const logger = require('../utils/logger');

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_REDIRECTS   = 10;
const MAX_RETRIES     = 5;
const CONNECT_TIMEOUT = 15_000;
const READ_TIMEOUT    = 30_000;
const STEAL_INTERVAL  = 2_000;   // ms between byte-stealing checks
const PROGRESS_INTERVAL = 200;   // ms between progress events
const STEAL_THRESHOLD = 0.20;    // chunk needs > 20% remaining to be considered for stealing
const MIN_STEAL_BYTES = 512 * 1024; // minimum remaining bytes to bother stealing
/**
 * A slow chunk must have at least (MIN_STEAL_BYTES * STEAL_MIN_FACTOR) remaining
 * before we attempt to split its range and assign the second half to a new worker.
 */
const STEAL_MIN_FACTOR = 2;

// Retry backoffs: 500 ms, 1 s, 2 s, 4 s, 8 s
const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Follow up to maxRedirects redirects, returning the final URL and the
 * cookies / headers extracted along the way.
 * @returns {Promise<{finalUrl:string, cookies:string[], responseHeaders:object}>}
 */
async function resolveUrl(urlStr, maxRedirects = MAX_REDIRECTS) {
  let current = urlStr;
  let hops = 0;
  let cookies = [];
  let lastHeaders = {};

  while (hops < maxRedirects) {
    const parsed = new URL(current);
    const mod = parsed.protocol === 'https:' ? https : http;

    const result = await new Promise((resolve, reject) => {
      const req = mod.request(
        {
          method: 'HEAD',
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; NexusDownloader/1.0)',
            ...(cookies.length ? { Cookie: cookies.join('; ') } : {}),
          },
          timeout: CONNECT_TIMEOUT,
        },
        (res) => {
          // Accumulate cookies
          const setCookie = res.headers['set-cookie'];
          if (setCookie) {
            cookies = cookies.concat(
              setCookie.map((c) => c.split(';')[0].trim())
            );
          }
          lastHeaders = res.headers;
          resolve({ statusCode: res.statusCode, location: res.headers.location });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Redirect HEAD timeout')); });
      req.end();
    });

    if (result.statusCode >= 300 && result.statusCode < 400 && result.location) {
      // Resolve relative redirects
      current = new URL(result.location, current).href;
      hops++;
    } else {
      break;
    }
  }

  return { finalUrl: current, cookies, responseHeaders: lastHeaders };
}

/**
 * Send a HEAD request to `url` and return server capability info.
 */
async function probeServer(url, extraHeaders = {}) {
  const parsed = new URL(url);
  const mod = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        method: 'HEAD',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NexusDownloader/1.0)',
          ...extraHeaders,
        },
        timeout: CONNECT_TIMEOUT,
      },
      (res) => {
        const contentLength = parseInt(res.headers['content-length'] || '0', 10);
        const acceptRanges = (res.headers['accept-ranges'] || '').toLowerCase();
        resolve({
          statusCode: res.statusCode,
          contentLength: isNaN(contentLength) ? 0 : contentLength,
          acceptRanges,
          contentType: res.headers['content-type'] || '',
          lastModified: res.headers['last-modified'] || '',
          etag: res.headers['etag'] || '',
          headers: res.headers,
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HEAD probe timeout')); });
    req.end();
  });
}

/**
 * Determine the optimal chunk count based on file size.
 */
function adaptiveChunkCount(fileSize) {
  const MB = 1024 * 1024;
  if (fileSize >= 500 * MB) return 32;
  if (fileSize >= 100 * MB) return 24;
  if (fileSize >= 50  * MB) return 16;
  if (fileSize >= 10  * MB) return 8;
  if (fileSize >= 2   * MB) return 4;
  return 1;
}

/**
 * Download a single byte range with retries.
 * Calls `onData(chunkIndex, buffer)` for each received buffer.
 * @returns {Promise<void>}
 */
function downloadRange(url, startByte, endByte, extraHeaders, chunkIndex, onData, abortSignal) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryDownload() {
      if (abortSignal && abortSignal.aborted) {
        return reject(new Error('Aborted'));
      }

      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;

      const req = mod.get(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; NexusDownloader/1.0)',
            Range: `bytes=${startByte}-${endByte}`,
            ...extraHeaders,
          },
          timeout: CONNECT_TIMEOUT,
        },
        (res) => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(
              Object.assign(
                new Error(`Authentication required (HTTP ${res.statusCode})`),
                { code: `HTTP_${res.statusCode}`, fatal: true }
              )
            );
          }
          if (res.statusCode === 404) {
            return reject(
              Object.assign(new Error('File no longer available (HTTP 404)'), {
                code: 'HTTP_404',
                fatal: true,
              })
            );
          }
          if (res.statusCode !== 206 && res.statusCode !== 200) {
            return handleError(new Error(`Unexpected status ${res.statusCode} on chunk ${chunkIndex}`));
          }

          let readTimer = setTimeout(
            () => req.destroy(new Error('Read timeout')),
            READ_TIMEOUT
          );

          res.on('data', (buf) => {
            clearTimeout(readTimer);
            readTimer = setTimeout(
              () => req.destroy(new Error('Read timeout')),
              READ_TIMEOUT
            );
            onData(chunkIndex, buf);
          });

          res.on('end', () => {
            clearTimeout(readTimer);
            resolve();
          });

          res.on('error', (err) => {
            clearTimeout(readTimer);
            handleError(err);
          });
        }
      );

      req.on('error', handleError);
      req.on('timeout', () => {
        req.destroy(new Error(`Connect timeout on chunk ${chunkIndex}`));
      });

      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          try { req.destroy(); } catch (_) {}
        });
      }
    }

    function handleError(err) {
      // Fatal errors are surfaced immediately without retry
      if (err.fatal) return reject(err);

      attempt++;
      if (attempt >= MAX_RETRIES) {
        return reject(new Error(`Chunk ${chunkIndex} failed after ${MAX_RETRIES} retries: ${err.message}`));
      }

      const delay = RETRY_DELAYS[attempt - 1] || 8000;
      logger.warn(`Chunk ${chunkIndex} error – retrying in ${delay}ms`, { err: err.message });
      setTimeout(tryDownload, delay);
    }

    tryDownload();
  });
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Download `url` to `outputPath` using parallel byte-range chunks.
 *
 * @param {string}   url
 * @param {string}   outputPath
 * @param {object}   [options]
 * @param {object}   [options.headers]          Extra request headers.
 * @param {string}   [options.downloadId]       Used as the resume state key.
 * @param {AbortController} [options.controller] For cancellation.
 * @param {Function} [onProgress]              ({ id, downloaded, total, progress, speed, avgSpeed, eta, chunksActive, chunksComplete })
 * @returns {Promise<string>} Resolves to `outputPath` when complete.
 */
async function downloadWithChunks(url, outputPath, options = {}, onProgress) {
  const {
    headers: extraHeaders = {},
    downloadId = null,
    controller = null,
  } = options;

  const abortSignal = controller ? controller.signal : null;
  const tempFiles = [];

  // ── STEP 1: URL resolution ────────────────────────────────────────────────
  let finalUrl = url;
  let cookieHeader = {};
  let serverResponseHeaders = {};

  try {
    const resolved = await resolveUrl(url);
    finalUrl = resolved.finalUrl;
    if (resolved.cookies.length) {
      cookieHeader = { Cookie: resolved.cookies.join('; ') };
    }
    serverResponseHeaders = resolved.responseHeaders;
  } catch (err) {
    logger.warn('URL resolution failed, using original URL', { err: err.message });
  }

  const reqHeaders = { ...extraHeaders, ...cookieHeader };

  // ── STEP 2: Server probe ──────────────────────────────────────────────────
  let fileSize = 0;
  let supportsRanges = false;
  let etag = '';
  let lastModified = '';

  try {
    const probe = await probeServer(finalUrl, reqHeaders);

    if (probe.statusCode === 401 || probe.statusCode === 403) {
      throw Object.assign(new Error('Authentication required'), { code: `HTTP_${probe.statusCode}` });
    }
    if (probe.statusCode === 404) {
      throw Object.assign(new Error('File no longer available'), { code: 'HTTP_404' });
    }

    fileSize = probe.contentLength;
    supportsRanges = probe.acceptRanges === 'bytes' && fileSize > 0;
    etag = probe.etag;
    lastModified = probe.lastModified;
  } catch (err) {
    if (err.code && err.code.startsWith('HTTP_')) throw err;
    logger.warn('Server probe failed, falling back to single-stream', { err: err.message });
  }

  // Fall back to single-stream if no range support or unknown size
  if (!supportsRanges || fileSize === 0) {
    return singleStreamDownload(
      finalUrl, outputPath, reqHeaders, fileSize, downloadId, abortSignal, onProgress
    );
  }

  // ── STEP 3: Adaptive chunk count ─────────────────────────────────────────
  const chunkCount = adaptiveChunkCount(fileSize);

  // ── STEP 4: Resume detection ─────────────────────────────────────────────
  let chunks = [];
  const savedState = resumeManager.load(outputPath);

  if (savedState && savedState.chunks && savedState.finalUrl === finalUrl) {
    chunks = savedState.chunks.map((c) => ({ ...c }));
    logger.info(`Resuming download with ${chunks.length} chunks`, { outputPath });
  } else {
    // Build fresh chunk map
    const chunkSize = Math.floor(fileSize / chunkCount);
    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize;
      const end = i === chunkCount - 1 ? fileSize - 1 : start + chunkSize - 1;
      const tempFile = `${outputPath}.part_${i}`;
      chunks.push({ index: i, start, end, downloaded: 0, complete: false, tempFile });
    }

    // Save initial state
    resumeManager.save(outputPath, {
      url,
      finalUrl,
      fileSize,
      chunkCount,
      chunks,
      headers: { cookie: cookieHeader.Cookie || '', etag, lastModified },
    });
  }

  // Accumulate temp file references
  for (const c of chunks) {
    if (!tempFiles.includes(c.tempFile)) tempFiles.push(c.tempFile);
  }

  // ── STEP 5: Parallel download with byte stealing ──────────────────────────
  const speedTracker = new SpeedTracker();
  let totalDownloaded = chunks.reduce((a, c) => a + c.downloaded, 0);
  let chunksComplete = chunks.filter((c) => c.complete).length;
  let chunksActive = 0;

  // Open append write streams for each incomplete chunk (resume from where we left off)
  const writeStreams = new Map();
  function getWriteStream(chunk) {
    if (writeStreams.has(chunk.index)) return writeStreams.get(chunk.index);
    const flags = chunk.downloaded > 0 ? 'a' : 'w';
    const ws = fs.createWriteStream(chunk.tempFile, { flags });
    writeStreams.set(chunk.index, ws);
    return ws;
  }

  // Progress emitter
  let lastProgressTime = 0;
  let lastProgressBytes = totalDownloaded;
  const speedSamples = [];

  function emitProgress() {
    const now = Date.now();
    if (now - lastProgressTime < PROGRESS_INTERVAL) return;

    const deltaBytes = totalDownloaded - lastProgressBytes;
    const deltaTime = (now - lastProgressTime) / 1000;
    const instantSpeed = deltaTime > 0 ? deltaBytes / deltaTime : 0;

    speedSamples.push(instantSpeed);
    if (speedSamples.length > 10) speedSamples.shift();
    const avgSpeed = speedSamples.reduce((a, v) => a + v, 0) / speedSamples.length;

    lastProgressTime = now;
    lastProgressBytes = totalDownloaded;

    const progress = fileSize > 0 ? Math.min(100, (totalDownloaded / fileSize) * 100) : 0;
    const eta = avgSpeed > 0 ? Math.ceil((fileSize - totalDownloaded) / avgSpeed) : 0;

    if (typeof onProgress === 'function') {
      onProgress({
        id: downloadId,
        downloaded: totalDownloaded,
        total: fileSize,
        progress,
        speed: instantSpeed,
        avgSpeed,
        eta,
        chunksActive,
        chunksComplete,
      });
    }
  }

  // Download one chunk (its incomplete range)
  async function downloadChunk(chunk) {
    if (chunk.complete || (abortSignal && abortSignal.aborted)) return;

    const resumeStart = chunk.start + chunk.downloaded;
    if (resumeStart > chunk.end) {
      chunk.complete = true;
      return;
    }

    chunksActive++;
    try {
      await downloadRange(
        finalUrl,
        resumeStart,
        chunk.end,
        reqHeaders,
        chunk.index,
        (idx, buf) => {
          const ws = getWriteStream(chunk);
          ws.write(buf);
          chunk.downloaded += buf.length;
          totalDownloaded += buf.length;
          speedTracker.addChunkSample(idx, buf.length);
          emitProgress();
        },
        abortSignal
      );
      chunk.complete = true;
      chunksComplete++;
    } finally {
      chunksActive--;
    }
  }

  // Byte stealing worker
  let stealTimer = null;
  const stealWorkers = [];

  function startByteStealingTimer() {
    stealTimer = setInterval(() => {
      if (abortSignal && abortSignal.aborted) return;

      // Find slowest chunk with >20% remaining
      const active = chunks.filter((c) => !c.complete);
      if (active.length === 0) return;

      let slowest = null;
      let slowestRemainingFrac = 0;

      for (const c of active) {
        const total = c.end - c.start + 1;
        const remaining = total - c.downloaded;
        const remainingFrac = remaining / total;
        if (remainingFrac > STEAL_THRESHOLD && remaining > MIN_STEAL_BYTES * STEAL_MIN_FACTOR) {
          if (remainingFrac > slowestRemainingFrac) {
            slowestRemainingFrac = remainingFrac;
            slowest = c;
          }
        }
      }

      if (!slowest) return;

      // Find fastest chunk (near completion)
      let fastest = null;
      let fastestRemainingFrac = 1;
      for (const c of active) {
        if (c === slowest) continue;
        const total = c.end - c.start + 1;
        const remainingFrac = (total - c.downloaded) / total;
        if (remainingFrac < fastestRemainingFrac) {
          fastestRemainingFrac = remainingFrac;
          fastest = c;
        }
      }

      if (!fastest && active.length > 1) fastest = active[0];
      if (!fastest) return; // only one active chunk; can't steal

      // Split the slow chunk's remaining range: give second half to a new worker
      const remaining = (slowest.end - slowest.start) - slowest.downloaded;
      if (remaining < MIN_STEAL_BYTES * STEAL_MIN_FACTOR) return;

      const splitPoint = slowest.start + slowest.downloaded + Math.floor(remaining / 2);
      const newChunkIndex = chunks.length;
      const newTempFile = `${outputPath}.part_${newChunkIndex}`;

      const newChunk = {
        index: newChunkIndex,
        start: splitPoint + 1,
        end: slowest.end,
        downloaded: 0,
        complete: false,
        tempFile: newTempFile,
      };

      // Shrink original chunk
      slowest.end = splitPoint;

      chunks.push(newChunk);
      tempFiles.push(newTempFile);

      logger.debug('Byte steal', {
        from: slowest.index,
        newChunk: newChunkIndex,
        splitPoint,
      });

      const p = downloadChunk(newChunk).catch((err) => {
        logger.warn('Stolen chunk failed', { index: newChunkIndex, err: err.message });
      });
      stealWorkers.push(p);
    }, STEAL_INTERVAL);
  }

  // Start auto-save
  resumeManager.startAutoSave(outputPath, () => ({
    url,
    finalUrl,
    fileSize,
    chunkCount: chunks.length,
    chunks: chunks.map((c) => ({ ...c })),
    headers: { cookie: cookieHeader.Cookie || '', etag, lastModified },
  }));

  startByteStealingTimer();

  try {
    // Download all initial chunks in parallel
    await Promise.all(chunks.filter((c) => !c.complete).map(downloadChunk));

    // Wait for any steal workers that were spawned
    await Promise.all(stealWorkers);
  } catch (err) {
    // Save current state on network interruption
    if (!err.fatal) {
      resumeManager.save(outputPath, {
        url,
        finalUrl,
        fileSize,
        chunkCount: chunks.length,
        chunks: chunks.map((c) => ({ ...c })),
        headers: { cookie: cookieHeader.Cookie || '', etag, lastModified },
      });
    }
    throw err;
  } finally {
    clearInterval(stealTimer);
    resumeManager.stopAutoSave(outputPath);
    // Close all write streams
    for (const [, ws] of writeStreams) {
      try { ws.end(); } catch (_) {}
    }
  }

  if (abortSignal && abortSignal.aborted) {
    throw new Error('Download aborted');
  }

  // ── STEP 7: Merge ─────────────────────────────────────────────────────────
  const sortedChunks = [...chunks].sort((a, b) => a.start - b.start);
  const writeStream = fs.createWriteStream(outputPath);

  for (const chunk of sortedChunks) {
    if (!fs.existsSync(chunk.tempFile)) continue;
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(chunk.tempFile);
      rs.pipe(writeStream, { end: false });
      rs.on('end', resolve);
      rs.on('error', reject);
    });
  }

  await new Promise((resolve, reject) =>
    writeStream.end((err) => (err ? reject(err) : resolve()))
  );

  // Verify final file size
  try {
    const stat = fs.statSync(outputPath);
    if (stat.size !== fileSize) {
      logger.warn('File size mismatch after merge', {
        expected: fileSize,
        actual: stat.size,
      });
    }
  } catch (_) {}

  // Clean up temp files and state
  resumeManager.clearWithTempFiles(outputPath, tempFiles);

  // Final progress event
  if (typeof onProgress === 'function') {
    onProgress({
      id: downloadId,
      downloaded: fileSize,
      total: fileSize,
      progress: 100,
      speed: 0,
      avgSpeed: 0,
      eta: 0,
      chunksActive: 0,
      chunksComplete: chunks.length,
    });
  }

  return outputPath;
}

// ─── STEP 8: Single-stream fallback ──────────────────────────────────────────

/**
 * Download via a single stream (for servers that don't support ranges).
 * @returns {Promise<string>}
 */
async function singleStreamDownload(url, outputPath, reqHeaders, fileSize, downloadId, abortSignal, onProgress) {
  return new Promise((resolve, reject) => {
    if (abortSignal && abortSignal.aborted) return reject(new Error('Aborted'));

    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const speedTracker = new SpeedTracker();
    let downloaded = 0;
    let knownSize = fileSize;

    const ws = fs.createWriteStream(outputPath);

    const req = mod.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NexusDownloader/1.0)',
          ...reqHeaders,
        },
        timeout: CONNECT_TIMEOUT,
      },
      (res) => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          ws.destroy();
          return reject(Object.assign(new Error('Authentication required'), { code: `HTTP_${res.statusCode}` }));
        }
        if (res.statusCode === 404) {
          ws.destroy();
          return reject(Object.assign(new Error('File no longer available'), { code: 'HTTP_404' }));
        }

        if (!knownSize) {
          knownSize = parseInt(res.headers['content-length'] || '0', 10) || 0;
        }

        let lastTs = Date.now();
        let lastBytes = 0;
        const speedSamples = [];

        res.on('data', (buf) => {
          downloaded += buf.length;
          speedTracker.addSample(buf.length);

          const now = Date.now();
          const delta = (now - lastTs) / 1000;
          if (delta >= 0.2) {
            const instantSpeed = (downloaded - lastBytes) / delta;
            speedSamples.push(instantSpeed);
            if (speedSamples.length > 10) speedSamples.shift();
            const avgSpeed = speedSamples.reduce((a, v) => a + v, 0) / speedSamples.length;
            const progress = knownSize > 0 ? Math.min(100, (downloaded / knownSize) * 100) : 0;
            const eta = avgSpeed > 0 ? Math.ceil((knownSize - downloaded) / avgSpeed) : 0;

            if (typeof onProgress === 'function') {
              onProgress({
                id: downloadId,
                downloaded,
                total: knownSize,
                progress,
                speed: instantSpeed,
                avgSpeed,
                eta,
                chunksActive: 1,
                chunksComplete: 0,
              });
            }
            lastTs = now;
            lastBytes = downloaded;
          }
        });

        res.pipe(ws);

        res.on('end', () => {
          ws.end(() => {
            if (typeof onProgress === 'function') {
              onProgress({
                id: downloadId,
                downloaded,
                total: knownSize || downloaded,
                progress: 100,
                speed: 0,
                avgSpeed: 0,
                eta: 0,
                chunksActive: 0,
                chunksComplete: 1,
              });
            }
            resolve(outputPath);
          });
        });

        res.on('error', (err) => {
          ws.destroy();
          reject(err);
        });
      }
    );

    req.on('error', (err) => {
      ws.destroy();
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy(new Error('Connection timeout'));
    });

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        try { req.destroy(); } catch (_) {}
        ws.destroy();
        reject(new Error('Aborted'));
      });
    }
  });
}

// ─── Legacy class wrapper (keeps backward-compat with downloadManager) ────────

class ChunkEngine extends EventEmitter {
  constructor(opts) {
    super();
    this.url = opts.url;
    this.outputFile = opts.outputFile;
    this.tempDir = opts.tempDir;
    this.headers = opts.headers || {};
    this.numChunks = opts.numChunks || 8;
    this.resumeState = opts.resumeState || null;
    this._controller = new AbortController();
    this._paused = false;
  }

  async start() {
    try {
      await downloadWithChunks(
        this.url,
        this.outputFile,
        {
          headers: this.headers,
          controller: this._controller,
        },
        (progress) => this.emit('progress', progress)
      );
      this.emit('complete', { outputFile: this.outputFile });
    } catch (err) {
      if (!this._controller.signal.aborted) this.emit('error', err);
    }
  }

  pause() {
    this._paused = true;
    // Cannot truly pause mid-download; abort and rely on resume-state
    this._controller.abort();
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._controller = new AbortController();
    this.start().catch((err) => this.emit('error', err));
  }

  abort() {
    this._controller.abort();
  }

  getState() {
    // No-op: state is managed by resumeManager via .nexus_state file
    return null;
  }
}

module.exports = ChunkEngine;
module.exports.downloadWithChunks = downloadWithChunks;
