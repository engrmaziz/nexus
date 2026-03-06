'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');

// Try to find ffmpeg in PATH or well-known locations
function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

  const candidates = process.platform === 'win32'
    ? ['ffmpeg.exe', path.join('C:\\ffmpeg\\bin', 'ffmpeg.exe')]
    : ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];

  for (const c of candidates) {
    try {
      const { execSync } = require('child_process');
      execSync(`"${c}" -version`, { stdio: 'ignore' });
      return c;
    } catch (_) {}
  }
  return 'ffmpeg'; // fallback – let it fail with a descriptive error
}

const FFMPEG_BIN = findFfmpeg();

/**
 * MergeEngine – thin wrapper around FFmpeg for:
 *   - mergeVideoAudio(videoFile, audioFile, outputFile)
 *   - concatTsFiles(tsFiles[], outputFile)
 *   - remux(inputFile, outputFile)
 *   - addSubtitle(videoFile, subtitleFile, outputFile, lang)
 */
class MergeEngine {
  /**
   * Merge separate video and audio tracks into a single container.
   */
  mergeVideoAudio(videoFile, audioFile, outputFile) {
    const args = [
      '-y',
      '-i', videoFile,
      '-i', audioFile,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputFile,
    ];
    return this._run(args, `Merge ${path.basename(outputFile)}`);
  }

  /**
   * Concatenate multiple TS segment files into a single MP4/MKV.
   */
  async concatTsFiles(tsFiles, outputFile) {
    if (tsFiles.length === 0) throw new Error('No TS files to concatenate');

    // Write a concat list file
    const listFile = path.join(os.tmpdir(), `nexus_concat_${Date.now()}.txt`);
    const lines = tsFiles.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listFile, lines, 'utf8');

    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      outputFile,
    ];

    try {
      await this._run(args, `Concat ${path.basename(outputFile)}`);
    } finally {
      try { fs.unlinkSync(listFile); } catch (_) {}
    }
  }

  /**
   * Remux a file to a different container without re-encoding.
   */
  remux(inputFile, outputFile) {
    const args = [
      '-y',
      '-i', inputFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputFile,
    ];
    return this._run(args, `Remux ${path.basename(outputFile)}`);
  }

  /**
   * Burn subtitles (hard-coded) or add as a stream (soft-coded).
   */
  addSubtitle(videoFile, subtitleFile, outputFile, lang = 'eng', hardcode = false) {
    let args;
    if (hardcode) {
      args = [
        '-y',
        '-i', videoFile,
        '-vf', `subtitles='${subtitleFile.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`,
        '-c:a', 'copy',
        outputFile,
      ];
    } else {
      args = [
        '-y',
        '-i', videoFile,
        '-i', subtitleFile,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-c:s', 'mov_text',
        '-metadata:s:s:0', `language=${lang}`,
        outputFile,
      ];
    }
    return this._run(args, `Subtitle ${path.basename(outputFile)}`);
  }

  /**
   * Probe a file and return its metadata as JSON.
   */
  probe(inputFile) {
    const ffprobeBin = FFMPEG_BIN.replace('ffmpeg', 'ffprobe');
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      inputFile,
    ];
    return new Promise((resolve, reject) => {
      let stdout = '';
      const proc = spawn(ffprobeBin, args);
      proc.stdout.on('data', (d) => (stdout += d));
      proc.on('close', (code) => {
        if (code === 0) {
          try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`ffprobe exited ${code}`));
        }
      });
      proc.on('error', reject);
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  _run(args, label) {
    return new Promise((resolve, reject) => {
      logger.debug('FFmpeg', { label, args });

      const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => (stderr += d));

      proc.on('close', (code) => {
        if (code === 0) {
          logger.debug('FFmpeg done', { label });
          resolve();
        } else {
          const err = new Error(`FFmpeg (${label}) exited with code ${code}: ${stderr.slice(-400)}`);
          logger.error('FFmpeg error', { label, code, stderr: stderr.slice(-400) });
          reject(err);
        }
      });

      proc.on('error', (err) => {
        if (err.code === 'ENOENT') {
          reject(new Error('FFmpeg not found. Please install FFmpeg and ensure it is in your PATH.'));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Return the FFmpeg binary path in use.
   */
  static getBinaryPath() {
    return FFMPEG_BIN;
  }
}

module.exports = MergeEngine;
