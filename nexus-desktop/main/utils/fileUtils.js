'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Ensure a directory exists; create it recursively if it doesn't.
 * @param {string} dirPath
 * @returns {string} the same dirPath
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/**
 * Move a file, falling back to copy+delete for cross-device moves.
 * @param {string} src
 * @param {string} dest
 */
function moveFile(src, dest) {
  ensureDir(path.dirname(dest));
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      // Cross-device: copy then delete
      copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

/**
 * Copy a file synchronously.
 * @param {string} src
 * @param {string} dest
 */
function copyFileSync(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

/**
 * Delete a file if it exists.
 * @param {string} filePath
 */
function deleteIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

/**
 * Recursively delete a directory.
 * @param {string} dirPath
 */
function deleteDir(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * Return the size of a file in bytes, or 0 if it doesn't exist.
 * @param {string} filePath
 * @returns {number}
 */
function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (_) {
    return 0;
  }
}

/**
 * Format bytes into a human-readable string.
 * @param {number} bytes
 * @param {number} [decimals=2]
 * @returns {string}
 */
function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/**
 * Generate an SHA-256 hash of a file.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Write data to a file atomically by writing to a temp file first,
 * then renaming.
 * @param {string} filePath
 * @param {Buffer|string} data
 */
function writeAtomic(filePath, data) {
  const tmp = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

/**
 * List files in a directory matching an optional extension.
 * @param {string} dirPath
 * @param {string} [ext]  e.g. '.mp4'
 * @returns {string[]}  absolute paths
 */
function listFiles(dirPath, ext = null) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((f) => !ext || path.extname(f).toLowerCase() === ext)
    .map((f) => path.join(dirPath, f));
}

/**
 * Get available disk space (bytes) on the partition containing the given path.
 * Returns Infinity if it cannot be determined.
 * @param {string} dirPath
 * @returns {Promise<number>}
 */
async function getFreeSpace(dirPath) {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      const drive = path.parse(dirPath).root;
      // Remove all backslashes to get the drive letter (e.g. "C:" from "C:\")
      const driveLetter = drive.replace(/\\/g, '');
      const out = execSync(`wmic logicaldisk where "DeviceID='${driveLetter}'" get FreeSpace /value`, { encoding: 'utf8' });
      const match = /FreeSpace=(\d+)/.exec(out);
      return match ? parseInt(match[1], 10) : Infinity;
    } else {
      const out = execSync(`df -k "${dirPath}" | tail -1 | awk '{print $4}'`, { encoding: 'utf8' });
      return parseInt(out.trim(), 10) * 1024;
    }
  } catch (_) {
    return Infinity;
  }
}

/**
 * Edge case [9]: Filename collision handling.
 * If a file with the given name already exists at destDir, append (2), (3), etc.
 * Never silently overwrites an existing file.
 * @param {string} destDir
 * @param {string} filename
 * @returns {string} A filename that does not yet exist at destDir.
 */
function uniqueFilename(destDir, filename) {
  const ext  = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let counter   = 2;

  while (fs.existsSync(path.join(destDir, candidate))) {
    candidate = `${base} (${counter})${ext}`;
    counter++;
  }

  return candidate;
}

/**
 * Edge case [7]: Detect whether a directory is on a FAT32 filesystem.
 * Returns true only when FAT32 is confirmed; false otherwise (including unknown).
 * @param {string} dirPath
 * @returns {Promise<boolean>}
 */
async function isFat32(dirPath) {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      const drive = path.parse(dirPath).root.replace(/\\/g, '');
      const out = execSync(
        `wmic logicaldisk where "DeviceID='${drive}'" get FileSystem /value`,
        { encoding: 'utf8', timeout: 5000 }
      );
      return /FileSystem=FAT32/i.test(out);
    } else if (process.platform === 'linux') {
      const out = execSync(`stat -f -c %T "${dirPath}"`, { encoding: 'utf8', timeout: 5000 });
      return /vfat/i.test(out.trim());
    } else if (process.platform === 'darwin') {
      const out = execSync(`diskutil info "${dirPath}" 2>/dev/null | grep "File System Personality"`, { encoding: 'utf8', timeout: 5000 });
      return /MS-DOS FAT32/i.test(out);
    }
    return false;
  } catch (_) {
    return false;
  }
}

module.exports = {
  ensureDir,
  moveFile,
  copyFileSync,
  deleteIfExists,
  deleteDir,
  fileSize,
  formatBytes,
  hashFile,
  writeAtomic,
  listFiles,
  getFreeSpace,
  uniqueFilename,
  isFat32,
};
