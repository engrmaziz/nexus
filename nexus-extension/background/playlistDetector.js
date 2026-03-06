// nexus-extension/background/playlistDetector.js
// Detects and parses playlist URLs across YouTube, Vimeo, Dailymotion and HLS/DASH.

const YOUTUBE_PLAYLIST_RE = /[?&]list=([A-Za-z0-9_-]+)/;
const YOUTUBE_CHANNEL_RE  = /\/(channel\/|c\/|@)[^/]+\/videos/i;
const VIMEO_ALBUM_RE      = /vimeo\.com\/(?:album|showcase)\/(\d+)/i;
const DAILYMOTION_PL_RE   = /dailymotion\.com\/playlist\/([a-z0-9]+)/i;
const M3U8_RE             = /\.m3u8(\?|$)/i;
const MPD_RE              = /\.mpd(\?|$)/i;

export const playlistDetector = {
  /**
   * Detect whether a URL represents a playlist.
   *
   * @param {string} url
   * @returns {Promise<{
   *   isPlaylist: boolean,
   *   type: 'youtube'|'youtube_channel'|'vimeo_album'|'dailymotion'|'hls'|'dash'|'none',
   *   id: string|null,
   *   url: string,
   *   label?: string
   * }>}
   */
  async detect(url) {
    if (!url) return { isPlaylist: false, type: 'none', id: null, url };

    let hostname = '';
    try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}

    // ── YouTube playlist ─────────────────────────────────────────────────────
    const ytMatch = YOUTUBE_PLAYLIST_RE.exec(url);
    if (ytMatch && (hostname === 'youtube.com' || hostname === 'youtu.be')) {
      return {
        isPlaylist: true,
        type: 'youtube',
        id: ytMatch[1],
        url: `https://www.youtube.com/playlist?list=${ytMatch[1]}`,
        label: 'YouTube Playlist',
      };
    }

    // ── YouTube channel /videos page ─────────────────────────────────────────
    if ((hostname === 'youtube.com' || hostname === 'youtu.be') && YOUTUBE_CHANNEL_RE.test(url)) {
      return {
        isPlaylist: true,
        type: 'youtube_channel',
        id: null,
        url,
        label: 'YouTube Channel',
      };
    }

    // ── Vimeo album / showcase ───────────────────────────────────────────────
    const vimeoMatch = VIMEO_ALBUM_RE.exec(url);
    if (vimeoMatch) {
      return {
        isPlaylist: true,
        type: 'vimeo_album',
        id: vimeoMatch[1],
        url,
        label: 'Vimeo Album',
      };
    }

    // ── Dailymotion playlist ─────────────────────────────────────────────────
    const dmMatch = DAILYMOTION_PL_RE.exec(url);
    if (dmMatch) {
      return {
        isPlaylist: true,
        type: 'dailymotion',
        id: dmMatch[1],
        url,
        label: 'Dailymotion Playlist',
      };
    }

    // ── HLS manifest ─────────────────────────────────────────────────────────
    if (M3U8_RE.test(url)) {
      return { isPlaylist: true, type: 'hls', id: null, url, label: 'HLS Stream' };
    }

    // ── DASH manifest ────────────────────────────────────────────────────────
    if (MPD_RE.test(url)) {
      return { isPlaylist: true, type: 'dash', id: null, url, label: 'DASH Stream' };
    }

    // ── Probe content-type via HEAD ──────────────────────────────────────────
    try {
      const res = await this._fetchHead(url);
      const ct = res.contentType || '';
      if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) {
        return { isPlaylist: true, type: 'hls', id: null, url, label: 'HLS Stream' };
      }
      if (ct.includes('dash+xml')) {
        return { isPlaylist: true, type: 'dash', id: null, url, label: 'DASH Stream' };
      }
    } catch (_) {}

    return { isPlaylist: false, type: 'none', id: null, url };
  },

  /**
   * Build the canonical YouTube playlist URL from a playlist ID.
   * @param {string} playlistId
   * @returns {string}
   */
  youtubePlaylistUrl(playlistId) {
    return `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  },

  /**
   * Build the canonical Vimeo album URL from an album ID.
   * @param {string} albumId
   * @returns {string}
   */
  vimeoAlbumUrl(albumId) {
    return `https://vimeo.com/album/${encodeURIComponent(albumId)}`;
  },

  /**
   * Build the canonical Dailymotion playlist URL from a playlist ID.
   * @param {string} playlistId
   * @returns {string}
   */
  dailymotionPlaylistUrl(playlistId) {
    return `https://www.dailymotion.com/playlist/${encodeURIComponent(playlistId)}`;
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
