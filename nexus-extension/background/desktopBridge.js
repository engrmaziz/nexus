// nexus-extension/background/desktopBridge.js
// Communicates with the Nexus desktop app via HTTP on localhost:6543

const NEXUS_PORT = 6543;
const BASE_URL   = `http://127.0.0.1:${NEXUS_PORT}`;
const TIMEOUT_MS = 8000;

async function request(method, path, body = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE_URL}${path}`, opts);
    const json = await res.json();

    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export const desktopBridge = {
  /**
   * Check whether the Nexus desktop app is running.
   * @returns {Promise<{ running: boolean, version: string }>}
   */
  async ping() {
    try {
      const data = await request('GET', '/health');
      return { running: true, version: data.version || '?' };
    } catch (_) {
      return { running: false, version: null };
    }
  },

  /**
   * Send a download to the Nexus desktop app.
   * @param {object} opts  { url, referrer?, headers?, filename?, saveDir?, quality? }
   * @returns {Promise<{ id: string }>}
   */
  async sendDownload(opts) {
    const { url, referrer, headers, filename, saveDir, quality } = opts;
    return request('POST', '/downloads', {
      url,
      referrer,
      headers,
      filename,
      saveDir,
      quality,
    });
  },

  /**
   * Get all current downloads.
   * @returns {Promise<object[]>}
   */
  async getDownloads() {
    return request('GET', '/downloads');
  },

  /**
   * Pause a download.
   */
  async pause(id) {
    return request('POST', `/downloads/${id}/pause`);
  },

  /**
   * Resume a download.
   */
  async resume(id) {
    return request('POST', `/downloads/${id}/resume`);
  },

  /**
   * Cancel a download.
   */
  async cancel(id) {
    return request('POST', `/downloads/${id}/cancel`);
  },

  /**
   * Get current settings from the desktop app.
   */
  async getSettings() {
    return request('GET', '/settings');
  },
};
