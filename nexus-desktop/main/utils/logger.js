'use strict';

const winston = require('winston');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(
  process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
  'logs'
);

const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// Human-readable format for the console / development
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${ts} [${level}] ${message}${metaStr}`;
  })
);

// Structured JSON format for log files
const fileFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const transports = [
  new winston.transports.Console({
    level: LOG_LEVEL,
    format: devFormat,
    silent: process.env.NODE_ENV === 'test',
  }),
  new winston.transports.File({
    level: 'info',
    format: fileFormat,
    dirname: LOG_DIR,
    filename: 'nexus.log',
    maxsize: 10 * 1024 * 1024,  // 10 MB
    maxFiles: 5,
    tailable: true,
  }),
  new winston.transports.File({
    level: 'error',
    format: fileFormat,
    dirname: LOG_DIR,
    filename: 'nexus-error.log',
    maxsize: 5 * 1024 * 1024,
    maxFiles: 3,
    tailable: true,
  }),
];

const logger = winston.createLogger({
  level: LOG_LEVEL,
  transports,
  exitOnError: false,
});

/**
 * Add a caller-label prefix for easier grepping.
 * Usage: logger.child({ module: 'downloadManager' })
 */
logger.childFor = (module) => logger.child({ module });

module.exports = logger;
