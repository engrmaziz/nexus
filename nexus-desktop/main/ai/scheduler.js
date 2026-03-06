'use strict';

const { getStatements } = require('../db/queries');
const logger = require('../utils/logger');

/**
 * BandwidthScheduler – decides whether downloads should run based on
 * user-defined time-window rules.
 *
 * Schedule rules are stored in the `settings` table under key `bandwidth_schedule`
 * as a JSON array of rule objects:
 *
 *   [
 *     {
 *       "start": "22:00",   // 24-hour HH:MM
 *       "end":   "06:00",   // next day ok
 *       "limit": 0,          // bytes/sec; 0 = unlimited
 *       "active": true
 *     }
 *   ]
 */
class BandwidthScheduler {
  constructor() {
    this._rules = [];
    this._loaded = false;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Load rules from the database (or use the provided array directly).
   * @param {object[]} [rules]
   */
  loadRules(rules) {
    if (rules) {
      this._rules = rules;
      this._loaded = true;
      return;
    }

    try {
      const q = getStatements();
      const row = q.getSetting.get('bandwidth_schedule');
      if (row) {
        this._rules = JSON.parse(row.value);
      } else {
        this._rules = [];
      }
      this._loaded = true;
    } catch (err) {
      logger.warn('Failed to load bandwidth schedule', { err: err.message });
      this._rules = [];
      this._loaded = true;
    }
  }

  /**
   * Persist rules to the database.
   * @param {object[]} rules
   */
  saveRules(rules) {
    this._rules = rules;
    try {
      const q = getStatements();
      q.setSetting.run({ key: 'bandwidth_schedule', value: JSON.stringify(rules) });
    } catch (err) {
      logger.warn('Failed to save bandwidth schedule', { err: err.message });
    }
  }

  /**
   * Can a download start right now?
   * Returns true if no active rules restrict the current time.
   * @returns {boolean}
   */
  canStart() {
    if (!this._loaded) this.loadRules();
    const activeRules = this._rules.filter((r) => r.active !== false);
    if (activeRules.length === 0) return true;

    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();

    for (const rule of activeRules) {
      if (!rule.start || !rule.end) continue;

      const startMins = this._parseTime(rule.start);
      const endMins = this._parseTime(rule.end);

      let inWindow;
      if (startMins <= endMins) {
        // Same-day window, e.g. 08:00 – 18:00
        inWindow = nowMins >= startMins && nowMins < endMins;
      } else {
        // Overnight window, e.g. 22:00 – 06:00
        inWindow = nowMins >= startMins || nowMins < endMins;
      }

      if (inWindow && rule.limit === 0) {
        // Unlimited in this window – allow
        return true;
      }
      if (inWindow && typeof rule.limit === 'number' && rule.limit > 0) {
        // Speed-limited window – allowed but throttled
        return true;
      }
    }

    // Default: allow if no rule matches
    return true;
  }

  /**
   * Return the current speed limit (bytes/sec) – 0 means unlimited.
   * @returns {number}
   */
  getCurrentLimit() {
    if (!this._loaded) this.loadRules();
    const activeRules = this._rules.filter((r) => r.active !== false);
    if (activeRules.length === 0) return 0;

    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();

    for (const rule of activeRules) {
      if (!rule.start || !rule.end) continue;

      const startMins = this._parseTime(rule.start);
      const endMins = this._parseTime(rule.end);

      let inWindow;
      if (startMins <= endMins) {
        inWindow = nowMins >= startMins && nowMins < endMins;
      } else {
        inWindow = nowMins >= startMins || nowMins < endMins;
      }

      if (inWindow) {
        return typeof rule.limit === 'number' ? rule.limit : 0;
      }
    }

    return 0;
  }

  /**
   * Return all configured rules.
   * @returns {object[]}
   */
  getRules() {
    if (!this._loaded) this.loadRules();
    return [...this._rules];
  }

  // ──────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────

  /** @returns {number} minutes since midnight */
  _parseTime(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }
}

module.exports = new BandwidthScheduler();
