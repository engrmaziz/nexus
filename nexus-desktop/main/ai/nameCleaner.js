'use strict';

const path = require('path');
const sanitize = require('sanitize-filename');

// Characters that are universally problematic in filenames
const UNSAFE_RE = /[<>:"/\\|?*\x00-\x1F]/g;

// Common noise patterns that often pollute downloaded filenames
const NOISE_PATTERNS = [
  /\bHD\b/gi,
  /\bFHD\b/gi,
  /\b4K\b/gi,
  /\b1080p\b/gi,
  /\b720p\b/gi,
  /\b480p\b/gi,
  /\b360p\b/gi,
  /\bBluRay\b/gi,
  /\bBDRip\b/gi,
  /\bDVDRip\b/gi,
  /\bWEBRip\b/gi,
  /\bWEB-DL\b/gi,
  /\bHDRip\b/gi,
  /\bx264\b/gi,
  /\bx265\b/gi,
  /\bHEVC\b/gi,
  /\bAAC\b/gi,
  /\bAC3\b/gi,
  /\bDTS\b/gi,
  /\[.*?\]/g,         // anything in square brackets
  /\(.*?\)/g,         // anything in parentheses (optional – disabled below)
];

// Patterns to apply for noise removal (parentheses removal is opt-in)
const ACTIVE_NOISE = NOISE_PATTERNS.slice(0, -1); // skip the last (parentheses) pattern

const MAX_LENGTH = 200; // characters before extension

/**
 * Clean and sanitize a filename.
 *
 * Rules applied (in order):
 *  1. Strip leading/trailing whitespace.
 *  2. Remove embedded percent-encoded sequences (URL decode).
 *  3. Remove unsafe characters.
 *  4. Collapse multiple spaces/dashes/underscores.
 *  5. Apply noise pattern removal.
 *  6. Trim to MAX_LENGTH while preserving extension.
 *  7. Ensure it's non-empty; fall back to 'download'.
 *  8. Run through sanitize-filename for final OS safety.
 *
 * @param {string} filename
 * @param {object} [opts]
 * @param {boolean} [opts.removeNoise=true]  Strip resolution/codec tags.
 * @param {boolean} [opts.truncate=true]     Enforce MAX_LENGTH.
 * @returns {string}
 */
function clean(filename = '', opts = {}) {
  const { removeNoise = true, truncate = true } = opts;

  if (!filename || typeof filename !== 'string') return 'download';

  let name = filename.trim();

  // URL-decode encoded characters
  try {
    name = decodeURIComponent(name.replace(/\+/g, ' '));
  } catch (_) {}

  // Extract extension before we mangle the name
  const ext = path.extname(name);
  let base = path.basename(name, ext);

  // Remove unsafe characters
  base = base.replace(UNSAFE_RE, ' ');

  // Collapse consecutive dots / multiple spaces / underscores
  base = base.replace(/\.{2,}/g, '.').replace(/\s{2,}/g, ' ').replace(/_{2,}/g, '_');

  // Remove noise patterns
  if (removeNoise) {
    for (const re of ACTIVE_NOISE) {
      base = base.replace(re, ' ');
    }
    base = base.replace(/\s{2,}/g, ' ').trim();
  }

  // Replace spaces with underscores (common convention)
  base = base.replace(/\s+/g, '_');

  // Remove leading/trailing dots, dashes, underscores
  base = base.replace(/^[._\-]+|[._\-]+$/g, '');

  // Truncate
  if (truncate && base.length > MAX_LENGTH) {
    base = base.slice(0, MAX_LENGTH).replace(/[._\-]+$/, '');
  }

  // Fallback for empty name
  if (!base) base = 'download';

  const result = base + (ext || '');

  // Final safety pass
  return sanitize(result, { replacement: '_' }) || 'download';
}

/**
 * Generate a unique filename by appending a counter if the name already exists.
 *
 * @param {string} dir
 * @param {string} filename
 * @returns {string}
 */
function makeUnique(dir, filename) {
  const fs = require('fs');
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let counter = 1;

  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}_${counter}${ext}`;
    counter++;
  }
  return candidate;
}

module.exports = { clean, makeUnique };
