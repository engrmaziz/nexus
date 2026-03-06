'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');

// ─── FFmpeg path ──────────────────────────────────────────────────────────────

function resolveFfmpeg() {
  // 1. Explicit env override
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

  // 2. ffmpeg-static bundled binary
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  } catch (_) {}

  // 3. Fallback: search PATH / common locations
  const candidates = process.platform === 'win32'
    ? ['ffmpeg.exe', path.join('C:\\ffmpeg\\bin', 'ffmpeg.exe')]
    : [
        'ffmpeg',
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/opt/homebrew/bin/ffmpeg',
        '/snap/bin/ffmpeg',
      ];

  for (const c of candidates) {
    try {
      require('child_process').execSync(`"${c}" -version`, { stdio: 'ignore' });
      return c;
    } catch (_) {}
  }

  return 'ffmpeg'; // Let it fail descriptively at runtime
}

const FFMPEG_BIN = resolveFfmpeg();
const FFPROBE_BIN = FFMPEG_BIN.replace(/ffmpeg(\.exe)?$/, (m, ext) => `ffprobe${ext || ''}`);
const MERGE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Write an FFmpeg concat list file (uses forward slashes for cross-platform
 * compatibility, as the spec requires).
 * @param {string[]} filePaths
 * @returns {string}  Path to the temp concat file.
 */
function writeConcatFile(filePaths) {
  const listPath = path.join(os.tmpdir(), `nexus_concat_${Date.now()}_${process.pid}.txt`);
  const lines = filePaths
    .map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\n`)
    .join('');
  fs.writeFileSync(listPath, lines, 'utf8');
  return listPath;
}

/**
 * Spawn FFmpeg with the given args.
 * Rejects if FFmpeg exits non-zero or the process takes longer than MERGE_TIMEOUT_MS.
 * @param {string[]} args
 * @param {string}   label  Human-readable label for logging.
 * @returns {Promise<void>}
 */
function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    logger.debug('FFmpeg', { label, bin: FFMPEG_BIN, args });

    let proc;
    try {
      proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (spawnErr) {
      return reject(new Error(`Failed to start FFmpeg: ${spawnErr.message}`));
    }

    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => (stderr += d));

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`FFmpeg timed out after ${MERGE_TIMEOUT_MS / 1000}s (${label})`));
    }, MERGE_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.debug('FFmpeg complete', { label });
        resolve();
      } else {
        const errMsg = `FFmpeg (${label}) exited ${code}: ${stderr.slice(-600)}`;
        logger.error('FFmpeg error', { label, code, stderr: stderr.slice(-600) });
        reject(new Error(errMsg));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error('FFmpeg not found. Install FFmpeg or set FFMPEG_PATH.'));
      } else {
        reject(err);
      }
    });
  });
}

// ─── Edge case [16]: Limit concurrent FFmpeg merge operations to 2 ────────────
// Queue others and show "Merging..." status.

const MAX_CONCURRENT_FFMPEG = 2;
let _activeFFmpeg = 0;
const _ffmpegQueue = [];

/**
 * Run FFmpeg respecting the concurrency limit.
 * Returns a promise that resolves when the job completes.
 * If at capacity, the job is queued and will run when a slot opens.
 * @param {Function} jobFn  Zero-arg async function that runs the actual FFmpeg work.
 * @param {string}   label  For logging.
 * @returns {Promise<void>}
 */
function runFfmpegQueued(jobFn, label) {
  return new Promise((resolve, reject) => {
    function tryRun() {
      if (_activeFFmpeg < MAX_CONCURRENT_FFMPEG) {
        _activeFFmpeg++;
        logger.debug(`FFmpeg slot acquired (${_activeFFmpeg}/${MAX_CONCURRENT_FFMPEG})`, { label });
        jobFn()
          .then(resolve, reject)
          .finally(() => {
            _activeFFmpeg--;
            logger.debug(`FFmpeg slot released (${_activeFFmpeg}/${MAX_CONCURRENT_FFMPEG})`, { label });
            // Drain the queue
            if (_ffmpegQueue.length > 0) {
              const next = _ffmpegQueue.shift();
              next();
            }
          });
      } else {
        logger.debug(`FFmpeg queue full – queuing job`, { label, queued: _ffmpegQueue.length + 1 });
        _ffmpegQueue.push(tryRun);
      }
    }
    tryRun();
  });
}

// ─── MergeEngine ─────────────────────────────────────────────────────────────

class MergeEngine {
  /**
   * Concatenate chunk part files (from chunkEngine) into the final file.
   * Edge case [16]: Runs through runFfmpegQueued – max 2 concurrent FFmpeg processes.
   * @param {string[]} chunkPaths  Ordered array of `.part_N` files.
   * @param {string}   outputPath
   * @returns {Promise<void>}
   */
  async mergeChunks(chunkPaths, outputPath) {
    if (chunkPaths.length === 0) throw new Error('No chunk files to merge');

    const listFile = writeConcatFile(chunkPaths);
    const label    = `mergeChunks → ${path.basename(outputPath)}`;
    const args = [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', listFile, '-c', 'copy', outputPath,
    ];

    try {
      await runFfmpegQueued(() => runFfmpeg(args, label), label);
    } finally {
      try { fs.unlinkSync(listFile); } catch (_) {}
    }

    const stat = fs.statSync(outputPath);
    if (stat.size === 0) throw new Error(`Merged file is empty: ${outputPath}`);
  }

  /**
   * Merge a separate video track and audio track into a single container.
   * Edge case [16]: Runs through runFfmpegQueued – max 2 concurrent FFmpeg processes.
   * @param {string} videoPath
   * @param {string} audioPath
   * @param {string} outputPath
   * @returns {Promise<void>}
   */
  async mergeAudioVideo(videoPath, audioPath, outputPath) {
    const label = `mergeAudioVideo → ${path.basename(outputPath)}`;
    const args = [
      '-y',
      '-i', videoPath, '-i', audioPath,
      '-c:v', 'copy', '-c:a', 'copy',
      '-movflags', '+faststart', '-shortest',
      outputPath,
    ];
    return runFfmpegQueued(() => runFfmpeg(args, label), label);
  }

  /** Alias for backward compatibility with dashEngine / hlsEngine */
  mergeVideoAudio(videoPath, audioPath, outputPath) {
    return this.mergeAudioVideo(videoPath, audioPath, outputPath);
  }

  /**
   * Concatenate TS / m4s segment files into a single output file.
   * Edge case [16]: Runs through runFfmpegQueued – max 2 concurrent FFmpeg processes.
   * @param {string[]} segmentPaths
   * @param {string}   outputPath
   * @returns {Promise<void>}
   */
  async concatSegments(segmentPaths, outputPath) {
    if (segmentPaths.length === 0) throw new Error('No segments to concatenate');

    const listFile = writeConcatFile(segmentPaths);
    const label    = `concatSegments → ${path.basename(outputPath)}`;
    const args = [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', listFile, '-c', 'copy', outputPath,
    ];

    try {
      await runFfmpegQueued(() => runFfmpeg(args, label), label);
    } finally {
      try { fs.unlinkSync(listFile); } catch (_) {}
    }
  }

  /** Alias kept for backward compat with hlsEngine (concatTsFiles) */
  concatTsFiles(tsFiles, outputPath) {
    return this.concatSegments(tsFiles, outputPath);
  }

  /**
   * Extract audio track from a video file.
   * @param {string} videoPath
   * @param {string} outputPath
   * @param {'mp3'|'flac'|'m4a'|'aac'} format
   * @returns {Promise<void>}
   */
  async extractAudio(videoPath, outputPath, format = 'mp3') {
    let codecArgs;
    switch (format) {
      case 'mp3':
        codecArgs = ['-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k'];
        break;
      case 'flac':
        codecArgs = ['-vn', '-af', 'flac'];
        break;
      case 'm4a':
      case 'aac':
        codecArgs = ['-vn', '-c:a', 'aac', '-b:a', '256k'];
        break;
      default:
        throw new Error(`Unsupported audio format: ${format}`);
    }

    const args = [
      '-y',
      '-i', videoPath,
      ...codecArgs,
      outputPath,
    ];
    return runFfmpeg(args, `extractAudio(${format}) → ${path.basename(outputPath)}`);
  }

  /**
   * Get media information using ffprobe.
   * @param {string} filePath
   * @returns {Promise<{duration, width, height, codec, bitrate, streams, format}>}
   */
  getMediaInfo(filePath) {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        filePath,
      ];

      logger.debug('ffprobe', { file: filePath });

      let proc;
      try {
        proc = spawn(FFPROBE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        return reject(new Error(`Failed to start ffprobe: ${err.message}`));
      }

      let stdout = '';
      let stderr = '';
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (d) => (stdout += d));
      proc.stderr.on('data', (d) => (stderr += d));

      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        reject(new Error('ffprobe timed out'));
      }, 60_000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          return reject(new Error(`ffprobe exited ${code}: ${stderr.slice(-300)}`));
        }
        try {
          const info = JSON.parse(stdout);
          const videoStream = (info.streams || []).find((s) => s.codec_type === 'video');
          const audioStream = (info.streams || []).find((s) => s.codec_type === 'audio');
          resolve({
            duration: parseFloat(info.format?.duration || 0),
            width: videoStream?.width || 0,
            height: videoStream?.height || 0,
            codec: videoStream?.codec_name || audioStream?.codec_name || '',
            bitrate: parseInt(info.format?.bit_rate || 0, 10),
            streams: info.streams || [],
            format: info.format || {},
          });
        } catch (parseErr) {
          reject(new Error(`Failed to parse ffprobe output: ${parseErr.message}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT') {
          reject(new Error('ffprobe not found. Install FFmpeg and ensure ffprobe is in PATH.'));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Remux a file to a different container without re-encoding.
   * @param {string} inputPath
   * @param {string} outputPath
   * @returns {Promise<void>}
   */
  remux(inputPath, outputPath) {
    const args = [
      '-y',
      '-i', inputPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ];
    return runFfmpeg(args, `remux → ${path.basename(outputPath)}`);
  }

  /**
   * Add a subtitle stream to a video.
   * @param {string}  videoPath
   * @param {string}  subtitlePath
   * @param {string}  outputPath
   * @param {string}  [lang='eng']
   * @param {boolean} [hardcode=false]
   * @returns {Promise<void>}
   */
  addSubtitle(videoPath, subtitlePath, outputPath, lang = 'eng', hardcode = false) {
    let args;
    if (hardcode) {
      const subPathEscaped = subtitlePath.replace(/\\/g, '/').replace(/'/g, "'\\''");
      args = [
        '-y',
        '-i', videoPath,
        '-vf', `subtitles='${subPathEscaped}'`,
        '-c:a', 'copy',
        outputPath,
      ];
    } else {
      args = [
        '-y',
        '-i', videoPath,
        '-i', subtitlePath,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-c:s', 'mov_text',
        '-metadata:s:s:0', `language=${lang}`,
        outputPath,
      ];
    }
    return runFfmpeg(args, `addSubtitle → ${path.basename(outputPath)}`);
  }

  /**
   * @deprecated Use getMediaInfo
   */
  probe(inputFile) {
    return this.getMediaInfo(inputFile);
  }

  /** Return the FFmpeg binary path in use. */
  static getBinaryPath() {
    return FFMPEG_BIN;
  }
}

module.exports = MergeEngine;
