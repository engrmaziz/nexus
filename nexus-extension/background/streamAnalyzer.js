// nexus-extension/background/streamAnalyzer.js
// Analyzes HLS, DASH, and direct video/audio stream URLs.

const HLS_PATTERNS   = /\.(m3u8)(\?|$)/i;
const DASH_PATTERNS  = /\.(mpd)(\?|$)/i;
const VIDEO_PATTERNS = /\.(mp4|webm|mkv|avi|mov|flv|ts|m4v)(\?|$)/i;
const AUDIO_PATTERNS = /\.(mp3|aac|flac|ogg|wav|m4a|opus)(\?|$)/i;

const FETCH_TIMEOUT_MS = 10000;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyze an HLS master playlist URL.
 * Fetches and parses the m3u8, returning an array of quality variant objects.
 *
 * @param {string} url
 * @returns {Promise<{ variants: Array<{ bandwidth: number, resolution: string, url: string, codecs?: string }>, url: string }>}
 */
export async function analyzeHLS(url) {
  const text = await _fetchText(url);
  const variants = _parseM3U8(text, url);
  return { url, variants };
}

/**
 * Analyze a DASH manifest URL (MPD).
 * Fetches and parses the XML, returning arrays of video and audio tracks.
 *
 * @param {string} url
 * @returns {Promise<{ videoTracks: object[], audioTracks: object[], url: string }>}
 */
export async function analyzeDASH(url) {
  const text = await _fetchText(url);
  const { videoTracks, audioTracks } = _parseMPD(text, url);
  return { url, videoTracks, audioTracks };
}

/**
 * Analyze a direct MP4 (or similar) URL via a HEAD request.
 * Returns file size and resume (range) support.
 *
 * @param {string} url
 * @returns {Promise<{ url: string, size: number, resumable: boolean, contentType: string, filename: string }>}
 */
export async function analyzeMP4(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timer);

    const size = parseInt(res.headers.get('content-length') || '0', 10);
    const acceptRanges = res.headers.get('accept-ranges') || '';
    const resumable = acceptRanges.toLowerCase().includes('bytes');
    const contentType = res.headers.get('content-type') || '';

    // Extract filename from Content-Disposition or URL path
    const cd = res.headers.get('content-disposition') || '';
    const cdFilename = /filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i.exec(cd)?.[1]?.trim();
    const urlFilename = new URL(url).pathname.split('/').pop() || 'download';
    const filename = cdFilename || decodeURIComponent(urlFilename);

    return { url, size, resumable, contentType, filename };
  } catch (err) {
    clearTimeout(timer);
    return { url, size: 0, resumable: false, contentType: '', filename: '', error: err.message };
  }
}

/**
 * Classify a URL without making a network request.
 *
 * @param {string} url
 * @returns {{ type: 'hls'|'dash'|'video'|'audio'|'unknown', url: string }}
 */
export function analyzeUrl(url) {
  if (!url) return { type: 'unknown', url };
  if (HLS_PATTERNS.test(url))   return { type: 'hls',  url };
  if (DASH_PATTERNS.test(url))  return { type: 'dash', url };
  if (VIDEO_PATTERNS.test(url)) return { type: 'video', url };
  if (AUDIO_PATTERNS.test(url)) return { type: 'audio', url };
  return { type: 'unknown', url };
}

/**
 * Analyze a URL by performing a lightweight HEAD request to inspect headers,
 * then call the appropriate deep analyzer.
 *
 * @param {string} url
 * @param {object} [extraHeaders]
 * @returns {Promise<object>}
 */
export async function analyzeUrlFull(url, extraHeaders = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      method: 'HEAD',
      headers: extraHeaders,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const ct = res.headers.get('content-type') || '';

    if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || HLS_PATTERNS.test(url)) {
      return analyzeHLS(url);
    }
    if (ct.includes('dash+xml') || DASH_PATTERNS.test(url)) {
      return analyzeDASH(url);
    }
    if (ct.startsWith('video/') || ct.startsWith('audio/') || VIDEO_PATTERNS.test(url) || AUDIO_PATTERNS.test(url)) {
      return analyzeMP4(url);
    }
    return analyzeMP4(url);
  } catch (err) {
    return { url, error: err.message, ...analyzeUrl(url) };
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse an M3U8 playlist string.
 * Handles both master playlists (EXT-X-STREAM-INF) and media playlists.
 *
 * @param {string} text  Raw M3U8 content
 * @param {string} baseUrl  Used to resolve relative URIs
 * @returns {Array<{ bandwidth: number, resolution: string, url: string, codecs?: string }>}
 */
function _parseM3U8(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const base = new URL(baseUrl);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

    // Parse attributes: BANDWIDTH=..., RESOLUTION=..., CODECS="..."
    const bandwidth = parseInt(_attr(line, 'BANDWIDTH') || '0', 10);
    const resolution = _attr(line, 'RESOLUTION') || '';
    const codecs = _attr(line, 'CODECS') || '';
    const name = _attr(line, 'NAME') || '';

    // Next non-comment line is the variant URI
    let variantUri = '';
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (next && !next.startsWith('#')) {
        variantUri = next;
        break;
      }
    }
    if (!variantUri) continue;

    const variantUrl = variantUri.startsWith('http')
      ? variantUri
      : new URL(variantUri, base).href;

    variants.push({ bandwidth, resolution, codecs, name, url: variantUrl });
  }

  // Sort highest bandwidth first
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

/**
 * Parse a DASH MPD XML string.
 * Returns separate video and audio track arrays.
 *
 * @param {string} text  Raw MPD XML content
 * @param {string} baseUrl
 * @returns {{ videoTracks: object[], audioTracks: object[] }}
 */
function _parseMPD(text, baseUrl) {
  const videoTracks = [];
  const audioTracks = [];

  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch (_) {
    return { videoTracks, audioTracks };
  }

  // Check for XML parse errors (DOMParser doesn't throw — it embeds an error node)
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    const msg = parseError.textContent?.slice(0, 200) || 'MPD parse error';
    throw new Error(`Invalid MPD XML: ${msg}`);
  }

  const base = new URL(baseUrl);
  const baseUrlEl = doc.querySelector('BaseURL');
  const mpdBase = baseUrlEl?.textContent?.trim() || base.origin + base.pathname.replace(/[^/]+$/, '');

  doc.querySelectorAll('AdaptationSet').forEach((adaptSet) => {
    const mimeType = adaptSet.getAttribute('mimeType') || '';
    const isVideo = mimeType.startsWith('video') || adaptSet.querySelector('Representation[width]');
    const isAudio = mimeType.startsWith('audio');

    adaptSet.querySelectorAll('Representation').forEach((rep) => {
      const id = rep.getAttribute('id') || '';
      const bandwidth = parseInt(rep.getAttribute('bandwidth') || '0', 10);
      const width = parseInt(rep.getAttribute('width') || '0', 10);
      const height = parseInt(rep.getAttribute('height') || '0', 10);
      const codecs = rep.getAttribute('codecs') || '';
      const frameRate = rep.getAttribute('frameRate') || '';

      // Get the base URL for this representation
      const repBaseUrl = rep.querySelector('BaseURL')?.textContent?.trim() || '';
      const trackUrl = repBaseUrl
        ? (repBaseUrl.startsWith('http') ? repBaseUrl : new URL(repBaseUrl, mpdBase).href)
        : baseUrl;

      const track = { id, bandwidth, codecs, url: trackUrl };

      if (isVideo || (width > 0 && height > 0)) {
        videoTracks.push({ ...track, width, height, frameRate });
      } else if (isAudio) {
        const lang = adaptSet.getAttribute('lang') || rep.getAttribute('lang') || '';
        audioTracks.push({ ...track, lang });
      }
    });
  });

  videoTracks.sort((a, b) => b.bandwidth - a.bandwidth);
  audioTracks.sort((a, b) => b.bandwidth - a.bandwidth);

  return { videoTracks, audioTracks };
}

/** Extract a named attribute value from an M3U8 tag line. */
function _attr(line, name) {
  const re = new RegExp(`${name}=("([^"]+)"|([^,\\s]+))`, 'i');
  const m = re.exec(line);
  return m ? (m[2] || m[3] || '') : null;
}
