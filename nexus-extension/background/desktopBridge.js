// nexus-extension/background/desktopBridge.js
// Communicates with the Nexus desktop app via HTTP, trying ports 6543-6546.

const CANDIDATE_PORTS = [6543, 6544, 6545, 6546];
const TIMEOUT_MS      = 8000;
const RECHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

// ── State ─────────────────────────────────────────────────────────────────────

let _cachedPort  = null;   // port number that responded, or null
let _recheckTimer = null;  // setInterval handle

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _request(port, method, path, body = null) {
  const url = `http://127.0.0.1:${port}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    };
    if (body !== null) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const json = await res.json().catch(() => ({}));

    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Try to find a responding port. Updates _cachedPort. */
async function _discover() {
  for (const port of CANDIDATE_PORTS) {
    try {
      const data = await _request(port, 'GET', '/health');
      _cachedPort = port;
      return port;
    } catch (_) {}
  }
  _cachedPort = null;
  return null;
}

/** Start the periodic re-check loop (idempotent). */
function _startRecheckLoop() {
  if (_recheckTimer !== null) return;
  _recheckTimer = setInterval(async () => {
    // Verify that the cached port still responds; if not, re-discover
    if (_cachedPort !== null) {
      try {
        await _request(_cachedPort, 'GET', '/health');
        return; // still alive
      } catch (_) {
        _cachedPort = null;
      }
    }
    await _discover();
  }, RECHECK_INTERVAL_MS);
}

/** Return the active port, discovering it if necessary. */
async function _getActivePort() {
  if (_cachedPort !== null) return _cachedPort;
  return _discover();
}

/** Make an authenticated request using the current active port. */
async function _apiRequest(method, path, body = null) {
  const port = await _getActivePort();
  if (port === null) throw new Error('Nexus desktop app is not running');
  return _request(port, method, path, body);
}

// ── Public API ─────────────────────────────────────────────────────────────────

export const desktopBridge = {
  /**
   * Initialize: discover port and start re-check loop.
   */
  async init() {
    await _discover();
    _startRecheckLoop();
  },

  /**
   * Check whether the Nexus desktop app is reachable.
   * @returns {Promise<boolean>}
   */
  async isConnected() {
    const port = await _getActivePort();
    return port !== null;
  },

  /**
   * Return the currently active port number, or null if not connected.
   * @returns {Promise<number|null>}
   */
  async getPort() {
    return _getActivePort();
  },

  /**
   * Check whether the Nexus desktop app is running and return its version.
   * @returns {Promise<{ running: boolean, version: string|null, port: number|null }>}
   */
  async ping() {
    try {
      const port = await _getActivePort();
      if (port === null) return { running: false, version: null, port: null };
      const data = await _request(port, 'GET', '/health');
      return { running: true, version: data.version || '?', port };
    } catch (_) {
      return { running: false, version: null, port: null };
    }
  },

  /**
   * Send a download task to the desktop app.
   * @param {object} opts  { url, referrer?, headers?, filename?, saveDir?, quality?, mimeType?, fileSize?, pageTitle?, type? }
   * @returns {Promise<{ id: string }>}
   */
  async sendDownload(opts) {
    const { url, referrer, headers, filename, saveDir, quality,
            mimeType, fileSize, pageTitle, type,
            // Legacy field aliases kept for backward compatibility
            contentType, size } = opts;
    return _apiRequest('POST', '/api/download', {
      url,
      referrer:  referrer  || '',
      headers:   headers   || {},
      filename:  filename  || '',
      saveDir:   saveDir   || '',
      quality:   quality   || '',
      mimeType:  mimeType  || contentType || '',
      fileSize:  fileSize  || size || 0,
      pageTitle: pageTitle || '',
      type:      type      || '',
    });
  },

  /**
   * Send a playlist download task to the desktop app.
   * @param {object} opts  { url, type, id?, quality?, saveDir? }
   * @returns {Promise<{ id: string }>}
   */
  async sendPlaylist(opts) {
    const { url, type, id, quality, saveDir } = opts;
    return _apiRequest('POST', '/api/playlist', {
      url,
      type: type || 'unknown',
      id: id || '',
      quality: quality || '',
      saveDir: saveDir || '',
    });
  },

  /**
   * Get all current downloads.
   * @returns {Promise<object[]>}
   */
  async getDownloads() {
    return _apiRequest('GET', '/downloads');
  },

  /**
   * Pause a download by ID.
   * @param {string} id
   */
  async pause(id) {
    return _apiRequest('POST', `/downloads/${encodeURIComponent(id)}/pause`);
  },

  /**
   * Resume a download by ID.
   * @param {string} id
   */
  async resume(id) {
    return _apiRequest('POST', `/downloads/${encodeURIComponent(id)}/resume`);
  },

  /**
   * Cancel a download by ID.
   * @param {string} id
   */
  async cancel(id) {
    return _apiRequest('POST', `/downloads/${encodeURIComponent(id)}/cancel`);
  },

  /**
   * Get current settings from the desktop app.
   */
  async getSettings() {
    return _apiRequest('GET', '/settings');
  },
};
