'use strict';

const logger = require('../utils/logger');
const { resetStatements } = require('./queries');

const CURRENT_VERSION = 3;

/**
 * Individual migration definitions.
 * Each migration runs exactly once and is identified by its version number.
 */
const MIGRATIONS = [
  {
    version: 1,
    description: 'Add speed_limit and user_agent to settings defaults',
    up(db) {
      db.prepare(`
        INSERT OR IGNORE INTO settings (key, value)
        VALUES
          ('max_concurrent', '3'),
          ('speed_limit',    '0'),
          ('save_dir',       ''),
          ('user_agent',     'Mozilla/5.0 (compatible; NexusDownloader/1.0)'),
          ('auto_start',     '1'),
          ('dark_mode',      '1'),
          ('notifications',  '1')
      `).run();
    },
  },
  {
    version: 2,
    description: 'Add subtitle_url and subtitle_lang columns to downloads',
    up(db) {
      const cols = db
        .prepare(`PRAGMA table_info(downloads)`)
        .all()
        .map((c) => c.name);
      if (!cols.includes('subtitle_url')) {
        db.exec(`ALTER TABLE downloads ADD COLUMN subtitle_url TEXT`);
      }
      if (!cols.includes('subtitle_lang')) {
        db.exec(`ALTER TABLE downloads ADD COLUMN subtitle_lang TEXT`);
      }
    },
  },
  {
    version: 3,
    description: 'Add bandwidth_schedule to settings',
    up(db) {
      db.prepare(`
        INSERT OR IGNORE INTO settings (key, value)
        VALUES ('bandwidth_schedule', '[]')
      `).run();
    },
  },
];

/**
 * Read the current schema version from the database.
 */
function getCurrentVersion(db) {
  const row = db
    .prepare(`SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`)
    .get();
  return row ? row.version : 0;
}

/**
 * Record that a migration has been applied.
 */
function setVersion(db, version) {
  db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(version);
}

/**
 * Run all pending migrations inside a single transaction.
 */
function run(db) {
  const current = getCurrentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current);

  if (pending.length === 0) {
    logger.debug('No pending migrations');
    return;
  }

  const applyAll = db.transaction(() => {
    for (const migration of pending) {
      logger.info(`Applying migration v${migration.version}: ${migration.description}`);
      migration.up(db);
      setVersion(db, migration.version);
    }
  });

  applyAll();
  resetStatements(); // prepared statements may reference new columns
  logger.info(`Migrations complete. Schema version: ${CURRENT_VERSION}`);
}

module.exports = { run, CURRENT_VERSION };
