'use strict';

const path = require('path');
const mimeTypes = require('mime-types');

/**
 * Category definitions – ordered from most-specific to least-specific.
 * Each entry has a name and matcher arrays (extensions, mimePrefix, urlPatterns).
 */
const CATEGORIES = [
  {
    name: 'video',
    extensions: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.3gp', '.m2ts'],
    mimePrefixes: ['video/'],
    urlPatterns: [/youtube\.com/, /youtu\.be/, /vimeo\.com/, /dailymotion\.com/, /twitch\.tv/,
      /facebook\.com\/watch/, /instagram\.com\/reel/, /tiktok\.com/],
  },
  {
    name: 'audio',
    extensions: ['.mp3', '.flac', '.aac', '.ogg', '.wav', '.m4a', '.opus', '.wma'],
    mimePrefixes: ['audio/'],
    urlPatterns: [/soundcloud\.com/, /spotify\.com/, /bandcamp\.com/],
  },
  {
    name: 'image',
    extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.heic'],
    mimePrefixes: ['image/'],
    urlPatterns: [/instagram\.com\/p\//, /flickr\.com/],
  },
  {
    name: 'document',
    extensions: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.txt', '.md', '.epub'],
    mimePrefixes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats',
      'application/vnd.ms-', 'text/'],
    urlPatterns: [],
  },
  {
    name: 'archive',
    extensions: ['.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz', '.zst'],
    mimePrefixes: ['application/zip', 'application/x-tar', 'application/gzip',
      'application/x-bzip2', 'application/x-7z'],
    urlPatterns: [],
  },
  {
    name: 'application',
    extensions: ['.exe', '.msi', '.dmg', '.deb', '.rpm', '.AppImage', '.apk', '.ipa'],
    mimePrefixes: ['application/x-msdownload', 'application/x-apple-diskimage',
      'application/vnd.android'],
    urlPatterns: [],
  },
  {
    name: 'other',
    extensions: [],
    mimePrefixes: [],
    urlPatterns: [],
  },
];

/**
 * Classify a download into a category.
 *
 * @param {string} filename
 * @param {string} [mimeType]
 * @param {string} [url]
 * @returns {string} category name
 */
function categorize(filename = '', mimeType = '', url = '') {
  const ext = path.extname(filename).toLowerCase();

  for (const cat of CATEGORIES) {
    if (cat.name === 'other') return 'other'; // fallback

    // Extension match
    if (ext && cat.extensions.includes(ext)) return cat.name;

    // MIME type match
    if (mimeType) {
      const lowerMime = mimeType.toLowerCase();
      if (cat.mimePrefixes.some((p) => lowerMime.startsWith(p.toLowerCase()))) {
        return cat.name;
      }
    }

    // URL pattern match
    if (url) {
      if (cat.urlPatterns.some((re) => re.test(url))) return cat.name;
    }
  }

  // Last resort: guess from extension using mime-types library
  if (ext) {
    const guessedMime = mimeTypes.lookup(ext);
    if (guessedMime) {
      return categorize('', guessedMime, '');
    }
  }

  return 'other';
}

/**
 * Return all known category names.
 * @returns {string[]}
 */
function listCategories() {
  return CATEGORIES.map((c) => c.name);
}

module.exports = { categorize, listCategories };
