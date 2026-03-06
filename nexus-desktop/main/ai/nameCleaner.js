'use strict';

const path = require('path');
const fs = require('fs');
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

// Site/platform title suffixes to remove
const TITLE_NOISE = [
  /\s*[-|–—]\s*YouTube\s*$/i,
  /\s*[-|–—]\s*Vimeo\s*$/i,
  /\s*[-|–—]\s*Dailymotion\s*$/i,
  /\s*[-|–—]\s*TikTok\s*$/i,
  /\s*[-|–—]\s*Instagram\s*$/i,
  /\s*[-|–—]\s*Facebook\s*$/i,
  /\s*[-|–—]\s*Twitter\s*$/i,
  /\s*\|\s*Watch\s+on\b.*$/i,
  /\s*\|\s*[A-Za-z0-9 ]+(TV|Network|Channel|Media|Stream)\s*$/i,
  /\s*\(Official\s+(Video|Music\s+Video|Audio|Lyric\s+Video|MV)\s*\)\s*/gi,
  /\s*\[Official\s+(Video|Music\s+Video|Audio|Lyric\s+Video|MV)\s*\]\s*/gi,
  /\s*Official\s+(Video|Music\s+Video|Audio)\s*/gi,
];

// Quality label map
const QUALITY_LABELS = {
  '2160p': '2160p', '4k': '4K', '4K': '4K',
  '1080p': '1080p', '720p': '720p',
  '480p': '480p', '360p': '360p',
  'audio': 'audio', 'best': null,
};

// Patterns to apply for noise removal (skip the last parentheses pattern for clean())
const ACTIVE_NOISE = NOISE_PATTERNS.slice(0, -1);

const MAX_LENGTH = 200; // characters before extension
const TITLE_MAX_LENGTH = 80;

/**
 * STEP 1 – Extract a clean name from a URL.
 * Remove query params, decode URL encoding, extract path segment.
 *
 * @param {string} url
 * @returns {string}
 */
function extractFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).pop() || 'download';
    return decodeURIComponent(segment.replace(/\+/g, ' '));
  } catch (_) {
    return 'download';
  }
}

/**
 * STEP 2 – Clean a page title for use as a filename.
 *
 * Removes: site names, quality tags, "(Official Video)", etc.
 * Trims to 80 characters.
 * Replaces unsafe filename chars with spaces or dashes.
 *
 * @param {string} title
 * @returns {string}
 */
function cleanTitle(title) {
  if (!title || typeof title !== 'string') return '';

  let t = title.trim();

  // Remove site/platform noise
  for (const re of TITLE_NOISE) {
    t = t.replace(re, '');
  }
  t = t.trim();

  // Remove unsafe chars (allow spaces and dashes)
  t = t.replace(UNSAFE_RE, ' ');

  // Collapse multiple spaces
  t = t.replace(/\s{2,}/g, ' ').trim();

  // Truncate to 80 chars (preserve word boundary)
  if (t.length > TITLE_MAX_LENGTH) {
    t = t.slice(0, TITLE_MAX_LENGTH).replace(/\s+\S*$/, '');
  }

  return t.trim();
}

/**
 * Full pipeline: URL extraction → page title cleaning → quality suffix → unique filename.
 *
 * @param {string} rawName     Dirty filename or page title
 * @param {string} [url]       Source URL (used as fallback for name)
 * @param {object} [opts]
 * @param {string} [opts.quality]     Quality label to append (e.g. '1080p')
 * @param {string} [opts.pageTitle]   Page title to prefer over rawName
 * @param {string} [opts.saveDir]     Directory to check for filename uniqueness
 * @returns {string}
 */
function cleanFromUrl(rawName, url = '', opts = {}) {
  const { quality, pageTitle, saveDir } = opts;

  // STEP 1 – Try to use the page title; fall back to rawName or URL segment
  let name = '';
  if (pageTitle) {
    name = cleanTitle(pageTitle);
  }
  if (!name && rawName) {
    name = cleanTitle(rawName);
  }
  if (!name && url) {
    name = extractFromUrl(url);
  }
  if (!name) name = 'download';

  // STEP 2 – Extract/preserve extension
  const ext = path.extname(name).toLowerCase() || path.extname(rawName || '').toLowerCase() || '';
  let base = path.basename(name, ext || undefined);
  if (!base) base = path.basename(rawName || 'download', ext || undefined);

  // Remove unsafe characters from base
  base = base.replace(UNSAFE_RE, ' ').replace(/\s{2,}/g, ' ').trim();

  // STEP 3 – Append quality suffix for video files
  if (quality && QUALITY_LABELS[quality] !== undefined && QUALITY_LABELS[quality] !== null) {
    base = `${base} [${QUALITY_LABELS[quality]}]`;
  }

  // Replace spaces with underscores for filesystem safety
  base = base.replace(/\s+/g, '_').replace(/^[._\-]+|[._\-]+$/g, '');
  if (!base) base = 'download';

  let filename = sanitize(base + (ext || ''), { replacement: '_' }) || 'download';

  // STEP 4 – Ensure unique filename
  if (saveDir) {
    filename = makeUnique(saveDir, filename);
  }

  return filename;
}

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
 * Stops at counter 9999 to prevent infinite loops.
 *
 * @param {string} dir
 * @param {string} filename
 * @returns {string}
 */
function makeUnique(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let counter = 2;
  const MAX_COUNTER = 9999;

  try {
    while (counter <= MAX_COUNTER && fs.existsSync(path.join(dir, candidate))) {
      candidate = `${base} (${counter})${ext}`;
      counter++;
    }
  } catch (_) {}

  return candidate;
}

module.exports = { clean, cleanFromUrl, cleanTitle, extractFromUrl, makeUnique };
