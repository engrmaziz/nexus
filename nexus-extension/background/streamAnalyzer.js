// nexus-extension/background/streamAnalyzer.js
// Analyzes a URL to determine whether it is an HLS/DASH/direct stream.

const HLS_PATTERNS  = /\.(m3u8)(\?|$)/i;
const DASH_PATTERNS = /\.(mpd)(\?|$)/i;
const VIDEO_PATTERNS = /\.(mp4|webm|mkv|avi|mov|flv|ts|m4v)(\?|$)/i;
const AUDIO_PATTERNS = /\.(mp3|aac|flac|ogg|wav|m4a|opus)(\?|$)/i;

/**
 * Classify a URL without making a network request.
 * @param {string} url
 * @returns {{ type: 'hls'|'dash'|'video'|'audio'|'download'|'unknown', url: string }}
 */
export function analyzeUrl(url) {
  if (!url) return { type: 'unknown', url };

  if (HLS_PATTERNS.test(url))   return { type: 'hls',  url };
  if (DASH_PATTERNS.test(url))  return { type: 'dash', url };
  if (VIDEO_PATTERNS.test(url)) return { type: 'video', url };
  if (AUDIO_PATTERNS.test(url)) return { type: 'audio', url };

  return { type: 'download', url };
}

/**
 * Analyze a URL by performing a lightweight HEAD request to inspect
 * content-type and content-disposition headers.
 * @param {string} url
 * @param {object} [headers]
 * @returns {Promise<{ type: string, url: string, contentType: string, size: number }>}
 */
export async function analyzeUrlRemote(url, headers = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const ct = res.headers.get('content-type') || '';
    const size = parseInt(res.headers.get('content-length') || '0', 10);
    const cd = res.headers.get('content-disposition') || '';

    let type = 'download';
    if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) type = 'hls';
    else if (ct.includes('dash+xml')) type = 'dash';
    else if (ct.startsWith('video/')) type = 'video';
    else if (ct.startsWith('audio/')) type = 'audio';
    else if (cd.includes('attachment')) type = 'download';

    // Fall back to URL-based analysis if content-type is generic
    if (type === 'download') {
      const byUrl = analyzeUrl(url);
      if (byUrl.type !== 'unknown') type = byUrl.type;
    }

    return { type, url, contentType: ct, size };
  } catch (err) {
    // Fall back to URL-only analysis
    return { ...analyzeUrl(url), contentType: '', size: 0, error: err.message };
  }
}
