'use strict';

const https = require('https');
const http = require('http');
const path = require('path');
const { URL } = require('url');

// Domains/patterns known to be supported by yt-dlp
const YTDLP_DOMAINS = [
  'youtube.com', 'youtu.be',
  'vimeo.com', 'dailymotion.com',
  'twitch.tv', 'facebook.com',
  'instagram.com', 'tiktok.com',
  'twitter.com', 'x.com',
  'soundcloud.com', 'bandcamp.com',
  'reddit.com', 'bilibili.com',
  'nicovideo.jp', 'weibo.com',
  'ok.ru', 'vk.com',
  'pornhub.com', 'xvideos.com',
];

/**
 * Check whether yt-dlp is likely needed for a URL.
 * @param {string} url
 * @returns {boolean}
 */
function isYtdlpSupported(url) {
  try {
    const { hostname } = new URL(url);
    const base = hostname.replace(/^www\./, '');
    return YTDLP_DOMAINS.some((d) => base === d || base.endsWith('.' + d));
  } catch (_) {
    return false;
  }
}

/**
 * Probe a URL with a HEAD (falling back to GET with Range: bytes=0-0)
 * to discover: content-length, content-type, suggested filename, accept-ranges.
 *
 * @param {string} url
 * @param {object} [headers]
 * @returns {Promise<{ size, contentType, filename, acceptsRanges }>}
 */
function probeUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const options = {
      method: 'HEAD',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NexusDownloader/1.0)',
        ...headers,
      },
      timeout: 10_000,
    };

    const req = mod.request(options, (res) => {
      const size = parseInt(res.headers['content-length'] || '0', 10);
      const contentType = res.headers['content-type'] || '';
      const acceptsRanges = (res.headers['accept-ranges'] || '') !== 'none';

      // Try to extract filename from Content-Disposition
      let filename = '';
      const cd = res.headers['content-disposition'] || '';
      const cdMatch = /filename\*?=(?:UTF-8''|")?([^;"\r\n]+)/i.exec(cd);
      if (cdMatch) {
        filename = decodeURIComponent(cdMatch[1].replace(/"/g, '').trim());
      }

      if (!filename) {
        filename = path.basename(parsed.pathname);
      }

      resolve({ size, contentType, filename, acceptsRanges });
    });

    req.on('error', (err) => {
      // Retry with GET + Range: bytes=0-0
      _probeViaGet(url, headers).then(resolve).catch(reject);
    });

    req.on('timeout', () => {
      req.destroy();
      _probeViaGet(url, headers).then(resolve).catch(reject);
    });

    req.end();
  });
}

function _probeViaGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const options = {
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NexusDownloader/1.0)',
        'Range': 'bytes=0-0',
        ...headers,
      },
      timeout: 10_000,
    };

    const req = mod.request(options, (res) => {
      res.destroy(); // Don't download the body
      const size = parseInt(
        res.headers['content-range']?.split('/')[1] || res.headers['content-length'] || '0', 10
      );
      const contentType = res.headers['content-type'] || '';
      const acceptsRanges = res.statusCode === 206;

      let filename = '';
      const cd = res.headers['content-disposition'] || '';
      const cdMatch = /filename\*?=(?:UTF-8''|")?([^;"\r\n]+)/i.exec(cd);
      if (cdMatch) {
        filename = decodeURIComponent(cdMatch[1].replace(/"/g, '').trim());
      }
      if (!filename) filename = path.basename(parsed.pathname);

      resolve({ size, contentType, filename, acceptsRanges });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Probe timeout')); });
    req.end();
  });
}

/**
 * Check whether the machine currently has network connectivity.
 * @returns {Promise<boolean>}
 */
function isOnline() {
  return new Promise((resolve) => {
    const req = https.request({ hostname: '8.8.8.8', path: '/', timeout: 5000, method: 'HEAD' }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Simple GET helper – returns the body as a string.
 * @param {string} url
 * @param {object} [headers]
 * @returns {Promise<string>}
 */
function getText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    let body = '';
    mod.get(
      { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search, headers },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return resolve(getText(res.headers.location, headers));
        }
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
        res.on('error', reject);
      }
    ).on('error', reject);
  });
}

module.exports = { isYtdlpSupported, probeUrl, isOnline, getText };
