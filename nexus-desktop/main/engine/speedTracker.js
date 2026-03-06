'use strict';

const BUFFER_SIZE = 60; // 60 samples - 1-second rolling window when sampled each second

/**
 * SpeedTracker – tracks download speed using a circular buffer of byte samples.
 *
 * Features:
 *   - Circular buffer of 60 samples (one per second)
 *   - Per-chunk speed tracking
 *   - Exponential moving average (α = 0.3) for smoothing
 *   - Peak speed tracking
 *   - Format helpers: toKBps, toMBps, toGBps
 */
class SpeedTracker {
  constructor() {
    this._buffer = new Array(BUFFER_SIZE).fill(null); // { bytes, ts }
    this._head = 0;
    this._count = 0;
    this._lastFlushTs = Date.now();
    this._pendingBytes = 0;      // bytes accumulated since last 1-second flush
    this._ema = 0;               // exponential moving average (bytes/sec)
    this._alpha = 0.3;           // EMA smoothing factor
    this._peakSpeed = 0;
    this._chunkSpeeds = new Map(); // chunkIndex -> { bytes, ts }
  }

  // ─── Core sample collection ──────────────────────────────────────────────

  /**
   * Add bytes received (called on every data chunk).
   * Automatically flushes a sample each second.
   */
  addSample(bytes) {
    this._pendingBytes += bytes;
    const now = Date.now();
    if (now - this._lastFlushTs >= 1000) {
      this._flush(now);
    }
  }

  /** Same as addSample – kept for backward compatibility. */
  update(bytes) {
    this.addSample(bytes);
  }

  _flush(now) {
    const elapsed = (now - this._lastFlushTs) / 1000;
    const instantSpeed = elapsed > 0 ? this._pendingBytes / elapsed : 0;

    const entry = { bytes: this._pendingBytes, ts: now, speed: instantSpeed };
    this._buffer[this._head] = entry;
    this._head = (this._head + 1) % BUFFER_SIZE;
    if (this._count < BUFFER_SIZE) this._count++;

    // Update EMA
    if (this._ema === 0) {
      this._ema = instantSpeed;
    } else {
      this._ema = this._alpha * instantSpeed + (1 - this._alpha) * this._ema;
    }

    if (instantSpeed > this._peakSpeed) this._peakSpeed = instantSpeed;

    this._pendingBytes = 0;
    this._lastFlushTs = now;
  }

  // ─── Speed queries ────────────────────────────────────────────────────────

  /**
   * Instantaneous speed (most recent 1-second sample), bytes/sec.
   */
  getInstantSpeed() {
    if (this._count === 0) return 0;
    const idx = (this._head - 1 + BUFFER_SIZE) % BUFFER_SIZE;
    const entry = this._buffer[idx];
    return entry ? entry.speed : 0;
  }

  /**
   * Average speed over the given window (seconds), bytes/sec.
   * Defaults to the full 60-second buffer.
   */
  getAvgSpeed(windowSeconds = 60) {
    if (this._count === 0) return 0;

    const now = Date.now();
    const cutoff = now - windowSeconds * 1000;
    let totalBytes = 0;
    let oldestTs = now;
    let newestTs = 0;
    let valid = 0;

    for (let i = 0; i < this._count; i++) {
      const idx = (this._head - 1 - i + BUFFER_SIZE) % BUFFER_SIZE;
      const entry = this._buffer[idx];
      if (!entry || entry.ts < cutoff) continue;
      totalBytes += entry.bytes;
      if (entry.ts < oldestTs) oldestTs = entry.ts;
      if (entry.ts > newestTs) newestTs = entry.ts;
      valid++;
    }

    if (valid < 1) return 0;
    const elapsed = (newestTs - oldestTs) / 1000;
    return elapsed > 0 ? totalBytes / elapsed : this._ema;
  }

  /** EMA-smoothed speed, bytes/sec. */
  getSpeed() {
    return this._ema;
  }

  /** All-time peak speed recorded, bytes/sec. */
  getPeakSpeed() {
    return this._peakSpeed;
  }

  /**
   * Estimated seconds until download completes.
   * @param {number} remaining  bytes remaining
   */
  getETA(remaining) {
    const speed = this._ema > 0 ? this._ema : this.getAvgSpeed();
    return speed > 0 ? Math.ceil(remaining / speed) : Infinity;
  }

  /** @deprecated Use getETA */
  eta(remaining) {
    return this.getETA(remaining);
  }

  // ─── Per-chunk tracking ───────────────────────────────────────────────────

  /**
   * Record bytes received for a specific chunk.
   * @param {number|string} chunkIndex
   * @param {number} bytes
   */
  addChunkSample(chunkIndex, bytes) {
    const now = Date.now();
    const prev = this._chunkSpeeds.get(chunkIndex) || { bytes: 0, ts: now, speed: 0 };
    const elapsed = (now - prev.ts) / 1000;
    const speed = elapsed > 0 ? bytes / elapsed : 0;
    this._chunkSpeeds.set(chunkIndex, { bytes: prev.bytes + bytes, ts: now, speed });
    this.addSample(bytes);
  }

  /**
   * Get the last measured speed for a specific chunk, bytes/sec.
   */
  getChunkSpeed(chunkIndex) {
    return this._chunkSpeeds.get(chunkIndex)?.speed ?? 0;
  }

  /** Remove a chunk from tracking (e.g. after it completes). */
  clearChunk(chunkIndex) {
    this._chunkSpeeds.delete(chunkIndex);
  }

  // ─── Format helpers ────────────────────────────────────────────────────────

  /** Convert bytes/sec to a human-readable string. */
  static toBytesPerSec(bps) {
    return `${Math.round(bps)} B/s`;
  }

  static toKBps(bps) {
    return `${(bps / 1024).toFixed(2)} KB/s`;
  }

  static toMBps(bps) {
    return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
  }

  static toGBps(bps) {
    return `${(bps / (1024 * 1024 * 1024)).toFixed(3)} GB/s`;
  }

  /**
   * Auto-select the best human-readable unit.
   */
  static formatSpeed(bps) {
    if (bps >= 1024 * 1024 * 1024) return SpeedTracker.toGBps(bps);
    if (bps >= 1024 * 1024)        return SpeedTracker.toMBps(bps);
    if (bps >= 1024)               return SpeedTracker.toKBps(bps);
    return SpeedTracker.toBytesPerSec(bps);
  }

  // ─── Reset ────────────────────────────────────────────────────────────────

  reset() {
    this._buffer = new Array(BUFFER_SIZE).fill(null);
    this._head = 0;
    this._count = 0;
    this._pendingBytes = 0;
    this._lastFlushTs = Date.now();
    this._ema = 0;
    this._peakSpeed = 0;
    this._chunkSpeeds.clear();
  }
}

module.exports = SpeedTracker;
