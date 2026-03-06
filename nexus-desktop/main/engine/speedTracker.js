'use strict';

const BUFFER_SIZE = 60; // 60 samples → 60-second rolling window when sampled every second

/**
 * SpeedTracker – tracks download speed using a circular buffer of byte samples.
 * Samples are collected whenever bytes are received; the speed is computed as
 * bytes / seconds over the rolling window.
 */
class SpeedTracker {
  constructor(windowSeconds = 5) {
    this.windowSeconds = windowSeconds;
    // Each entry: { bytes, ts }
    this._buffer = new Array(BUFFER_SIZE).fill(null);
    this._head = 0;
    this._count = 0;
    this._totalBytes = 0;
    this._lastTs = Date.now();
    this._sampleBytes = 0;  // accumulator between flushes
  }

  /**
   * Feed in the number of bytes received in this IO event.
   */
  update(bytes) {
    this._sampleBytes += bytes;
    const now = Date.now();

    // Flush into the circular buffer at most once per 250 ms
    if (now - this._lastTs >= 250) {
      this._flush(now);
    }
  }

  _flush(now) {
    const entry = { bytes: this._sampleBytes, ts: now };
    this._buffer[this._head] = entry;
    this._head = (this._head + 1) % BUFFER_SIZE;
    if (this._count < BUFFER_SIZE) this._count++;

    this._sampleBytes = 0;
    this._lastTs = now;
  }

  /**
   * Return current speed in bytes/second based on the rolling window.
   */
  getSpeed() {
    if (this._count === 0) return 0;

    const now = Date.now();
    const cutoff = now - this.windowSeconds * 1000;

    let bytes = 0;
    let oldest = now;
    let newest = 0;
    let valid = 0;

    for (let i = 0; i < this._count; i++) {
      const idx = (this._head - 1 - i + BUFFER_SIZE) % BUFFER_SIZE;
      const entry = this._buffer[idx];
      if (!entry || entry.ts < cutoff) continue;
      bytes += entry.bytes;
      if (entry.ts < oldest) oldest = entry.ts;
      if (entry.ts > newest) newest = entry.ts;
      valid++;
    }

    if (valid < 2 || newest <= oldest) return bytes > 0 ? bytes : 0;

    const elapsed = (newest - oldest) / 1000;
    return elapsed > 0 ? bytes / elapsed : 0;
  }

  /**
   * Estimated time remaining in seconds.
   */
  eta(remaining) {
    const speed = this.getSpeed();
    return speed > 0 ? Math.ceil(remaining / speed) : Infinity;
  }

  /**
   * Human-readable speed string, e.g. "4.2 MB/s"
   */
  static formatSpeed(bytesPerSec) {
    if (bytesPerSec >= 1024 * 1024 * 1024) {
      return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
    }
    if (bytesPerSec >= 1024 * 1024) {
      return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
    }
    if (bytesPerSec >= 1024) {
      return `${(bytesPerSec / 1024).toFixed(2)} KB/s`;
    }
    return `${Math.round(bytesPerSec)} B/s`;
  }

  /**
   * Reset all tracking data.
   */
  reset() {
    this._buffer = new Array(BUFFER_SIZE).fill(null);
    this._head = 0;
    this._count = 0;
    this._sampleBytes = 0;
    this._lastTs = Date.now();
  }
}

module.exports = SpeedTracker;
