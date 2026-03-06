'use strict';

const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const logger = require('../utils/logger');

/**
 * Known subtitle API providers.
 * Each provider has a search(title, year) -> Promise<result[]> method and
 * a download(result) -> Promise<string (srt text)> method.
 */

// ─── OpenSubtitles REST API (v1 – no auth required for basic search) ────────

const OPENSUBS_API = 'https://rest.opensubtitles.org/search';
const OPENSUBS_HEADERS = {
  'User-Agent': 'NexusDownloader/1.0',
  'X-User-Agent': 'NexusDownloader/1.0',
};

async function searchOpenSubtitles(title, lang = 'en', year = null) {
  const query = encodeURIComponent(title.replace(/\./g, ' '));
  const yearPart = year ? `/year-${year}` : '';
  const url = `${OPENSUBS_API}/query-${query}${yearPart}/sublanguageid-${lang}`;

  try {
    const body = await fetchJson(url, OPENSUBS_HEADERS);
    if (!Array.isArray(body)) return [];

    return body.slice(0, 5).map((r) => ({
      provider: 'opensubtitles',
      id: r.IDSubtitleFile,
      title: r.MovieName,
      lang: r.SubLanguageID,
      downloadUrl: r.SubDownloadLink,
      filename: r.SubFileName,
      score: parseFloat(r.Score || '0'),
    }));
  } catch (err) {
    logger.warn('OpenSubtitles search failed', { err: err.message });
    return [];
  }
}

async function downloadOpenSubtitles(result) {
  // OpenSubtitles download links return a gzipped SRT
  const buf = await fetchBuffer(result.downloadUrl);
  const zlib = require('zlib');
  return new Promise((resolve, reject) => {
    zlib.gunzip(buf, (err, decoded) => {
      if (err) reject(err);
      else resolve(decoded.toString('utf8'));
    });
  });
}

// ─── SubDL ───────────────────────────────────────────────────────────────────

const SUBDL_SEARCH = 'https://subdl.com/s/';

async function searchSubDL(title, lang = 'en') {
  const query = encodeURIComponent(title);
  const url = `${SUBDL_SEARCH}${query}?l=${lang}`;
  try {
    // SubDL has an HTML interface; return empty for now (no public REST)
    return [];
  } catch (_) {
    return [];
  }
}

// ─── Public facade ───────────────────────────────────────────────────────────

/**
 * Search all providers for subtitles matching title.
 * @param {string} title
 * @param {object} opts
 * @param {string[]} [opts.langs=['en']]
 * @param {number}  [opts.year]
 * @returns {Promise<object[]>} sorted by score desc
 */
async function search(title, { langs = ['en'], year = null } = {}) {
  const promises = langs.map((lang) => searchOpenSubtitles(title, lang, year));
  const results = (await Promise.all(promises)).flat();
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Download a subtitle result and save to disk.
 * @param {object} result  as returned by search()
 * @param {string} saveDir  directory to save the .srt file
 * @returns {Promise<string>}  path to saved file
 */
async function downloadSubtitle(result, saveDir) {
  let srtText;

  switch (result.provider) {
    case 'opensubtitles':
      srtText = await downloadOpenSubtitles(result);
      break;
    default:
      throw new Error(`Unknown subtitle provider: ${result.provider}`);
  }

  const filename = result.filename || `${result.title}_${result.lang}.srt`;
  const outPath = path.join(saveDir, filename.replace(/[<>:"/\\|?*]/g, '_'));
  fs.writeFileSync(outPath, srtText, 'utf8');
  logger.info('Subtitle saved', { path: outPath });
  return outPath;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function fetchBuffer(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const chunks = [];
    mod.get(url, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(fetchBuffer(res.headers.location, headers));
      }
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = { search, downloadSubtitle };
