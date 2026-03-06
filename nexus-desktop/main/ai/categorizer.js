'use strict';

const path = require('path');
const mimeTypes = require('mime-types');

/**
 * Category definitions – ordered from most-specific to least-specific.
 * Each entry has a name, subcategory mappings, and matcher arrays.
 */
const CATEGORIES = [
  {
    name: 'video',
    extensions: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.3gp', '.m2ts', '.vob'],
    mimePrefixes: ['video/'],
    urlPatterns: [/youtube\.com/, /youtu\.be/, /vimeo\.com/, /dailymotion\.com/, /twitch\.tv/,
      /facebook\.com\/watch/, /instagram\.com\/reel/, /tiktok\.com/],
    subcategories: {
      '.mkv': 'movies', '.mp4': 'movies', '.avi': 'movies', '.mov': 'movies',
      '.webm': 'web', '.ts': 'tv', '.m4v': 'movies', '.vob': 'dvd',
    },
    defaultSubcategory: 'movies',
    suggestedFolder: 'Videos',
  },
  {
    name: 'audio',
    extensions: ['.mp3', '.flac', '.aac', '.ogg', '.wav', '.m4a', '.opus', '.wma', '.aiff'],
    mimePrefixes: ['audio/'],
    urlPatterns: [/soundcloud\.com/, /spotify\.com/, /bandcamp\.com/],
    subcategories: {
      '.flac': 'lossless', '.wav': 'lossless', '.aiff': 'lossless',
      '.mp3': 'music', '.m4a': 'music', '.ogg': 'music',
    },
    defaultSubcategory: 'music',
    suggestedFolder: 'Music',
  },
  {
    name: 'image',
    extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.heic', '.psd', '.ai'],
    mimePrefixes: ['image/'],
    urlPatterns: [/instagram\.com\/p\//, /flickr\.com/],
    subcategories: {
      '.psd': 'design', '.ai': 'design', '.svg': 'design',
      '.gif': 'animated',
    },
    defaultSubcategory: 'photos',
    suggestedFolder: 'Images',
  },
  {
    name: 'document',
    extensions: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.txt', '.md', '.epub', '.rtf'],
    mimePrefixes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats',
      'application/vnd.ms-', 'text/'],
    urlPatterns: [],
    subcategories: {
      '.pdf': 'pdf', '.epub': 'ebooks',
      '.doc': 'word', '.docx': 'word',
      '.xls': 'excel', '.xlsx': 'excel',
      '.ppt': 'powerpoint', '.pptx': 'powerpoint',
    },
    defaultSubcategory: 'documents',
    suggestedFolder: 'Documents',
  },
  {
    name: 'software',
    extensions: ['.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.apk', '.ipa', '.appimage', '.iso'],
    mimePrefixes: ['application/x-msdownload', 'application/x-apple-diskimage',
      'application/vnd.android'],
    urlPatterns: [],
    subcategories: {
      '.exe': 'windows', '.msi': 'windows',
      '.dmg': 'macos', '.pkg': 'macos',
      '.deb': 'linux', '.rpm': 'linux', '.appimage': 'linux',
      '.apk': 'android', '.ipa': 'ios',
      '.iso': 'disk-images',
    },
    defaultSubcategory: 'installers',
    suggestedFolder: 'Software',
  },
  {
    name: 'archive',
    extensions: ['.zip', '.tar', '.gz', '.bz2', '.xz', '.zst', '.lz', '.lzma', '.7z', '.rar'],
    mimePrefixes: ['application/zip', 'application/x-tar', 'application/gzip',
      'application/x-bzip2', 'application/x-7z'],
    urlPatterns: [],
    subcategories: {
      '.zip': 'compressed', '.7z': 'compressed', '.rar': 'compressed',
    },
    defaultSubcategory: 'compressed',
    suggestedFolder: 'Archives',
  },
  {
    name: 'code',
    extensions: ['.py', '.js', '.ts', '.java', '.cpp', '.c', '.cs', '.go', '.rs', '.php', '.sql', '.db'],
    mimePrefixes: ['text/x-python', 'text/javascript', 'application/javascript'],
    urlPatterns: [],
    subcategories: {
      '.py': 'python', '.js': 'javascript', '.ts': 'typescript',
      '.java': 'java', '.cpp': 'cpp', '.c': 'c',
      '.cs': 'csharp', '.go': 'go', '.rs': 'rust', '.php': 'php',
    },
    defaultSubcategory: 'source',
    suggestedFolder: 'Code',
  },
  {
    name: 'other',
    extensions: [],
    mimePrefixes: [],
    urlPatterns: [],
    subcategories: {},
    defaultSubcategory: 'misc',
    suggestedFolder: 'Other',
  },
];

/**
 * Classify a download into a category.
 * Returns a simple string for backward compatibility.
 *
 * @param {string} filename
 * @param {string} [mimeType]
 * @param {string} [url]
 * @returns {string} category name
 */
function categorize(filename = '', mimeType = '', url = '') {
  return categorizeDetailed(filename, mimeType, url).category;
}

/**
 * Classify a download and return full metadata.
 *
 * @param {string} filename
 * @param {string} [mimeType]
 * @param {string} [url]
 * @returns {{ category: string, subcategory: string, suggestedFolder: string }}
 */
function categorizeDetailed(filename = '', mimeType = '', url = '') {
  const ext = path.extname(filename).toLowerCase();

  for (const cat of CATEGORIES) {
    if (cat.name === 'other') {
      return {
        category: 'other',
        subcategory: 'misc',
        suggestedFolder: 'Other',
      };
    }

    let matched = false;

    // Extension match
    if (ext && cat.extensions.includes(ext)) {
      matched = true;
    }

    // MIME type match
    if (!matched && mimeType) {
      const lowerMime = mimeType.toLowerCase();
      if (cat.mimePrefixes.some((p) => lowerMime.startsWith(p.toLowerCase()))) {
        matched = true;
      }
    }

    // URL pattern match
    if (!matched && url) {
      if (cat.urlPatterns.some((re) => re.test(url))) {
        matched = true;
      }
    }

    if (matched) {
      const subcategory = (ext && cat.subcategories[ext]) || cat.defaultSubcategory;
      return {
        category: cat.name,
        subcategory,
        suggestedFolder: cat.suggestedFolder,
      };
    }
  }

  // Last resort: guess from extension using mime-types library
  if (ext) {
    const guessedMime = mimeTypes.lookup(ext);
    if (guessedMime) {
      return categorizeDetailed('', guessedMime, '');
    }
  }

  return { category: 'other', subcategory: 'misc', suggestedFolder: 'Other' };
}

/**
 * Return all known category names.
 * @returns {string[]}
 */
function listCategories() {
  return CATEGORIES.map((c) => c.name);
}

module.exports = { categorize, categorizeDetailed, listCategories };
