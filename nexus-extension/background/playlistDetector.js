// nexus-extension/background/playlistDetector.js
// Detects and parses playlist URLs (YouTube playlists, m3u8 playlists, etc.)

const YOUTUBE_PLAYLIST_RE = /[?&]list=([A-Za-z0-9_-]+)/;
const M3U8_RE = /\.m3u8(\?|$)/i;

export const playlistDetector = {
  /**
   * Detect whether a URL represents a playlist.
   * @param {string} url
   * @returns {Promise<{ isPlaylist: boolean, type: string, id: string|null, url: string }>}
   */
  async detect(url) {
    if (!url) return { isPlaylist: false, type: 'none', id: null, url };

    // YouTube playlist
    const ytMatch = YOUTUBE_PLAYLIST_RE.exec(url);
    const hostname = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
    if (ytMatch && (hostname === 'youtube.com' || hostname === 'youtu.be')) {
      return { isPlaylist: true, type: 'youtube', id: ytMatch[1], url };
    }

    // HLS manifest (is itself a "playlist")
    if (M3U8_RE.test(url)) {
      return { isPlaylist: true, type: 'hls', id: null, url };
    }

    // Try to fetch and parse as M3U
    try {
      const res = await this._fetchHead(url);
      const ct = res.contentType || '';
      if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) {
        return { isPlaylist: true, type: 'hls', id: null, url };
      }
      if (ct.includes('dash+xml')) {
        return { isPlaylist: true, type: 'dash', id: null, url };
      }
    } catch (_) {}

    return { isPlaylist: false, type: 'none', id: null, url };
  },

  /**
   * Given a YouTube playlist ID, return the full playlist URL.
   */
  youtubePlaylistUrl(playlistId) {
    return `https://www.youtube.com/playlist?list=${playlistId}`;
  },

  async _fetchHead(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
      return { contentType: res.headers.get('content-type') || '' };
    } finally {
      clearTimeout(timer);
    }
  },
};
