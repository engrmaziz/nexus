'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const downloadManager = require('./engine/downloadManager');
const { getStatements } = require('./db/queries');
const networkUtils = require('./utils/networkUtils');
const logger = require('./utils/logger');

const PORT = process.env.NEXUS_PORT || 6543;
const ALLOWED_ORIGIN = `http://localhost:${PORT}`;

let httpServer = null;
let io = null;

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", 'chrome-extension:'],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests from the extension (null origin) or localhost
    if (!origin || origin.startsWith('chrome-extension://') || origin === ALLOWED_ORIGIN) {
      cb(null, true);
    } else {
      cb(new Error('CORS blocked'));
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Nexus-Key'],
}));
app.use(morgan('dev', { stream: { write: (m) => logger.debug(m.trim()) } }));
app.use(express.json({ limit: '1mb' }));

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ── Downloads ─────────────────────────────────────────────────────────────────

app.get('/downloads', (_req, res) => {
  try {
    res.json(downloadManager.getAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/downloads/:id', (req, res) => {
  const dl = downloadManager.getOne(req.params.id);
  if (!dl) return res.status(404).json({ error: 'Not found' });
  res.json(dl);
});

app.post('/downloads', async (req, res) => {
  const { url, ...rest } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    new URL(url); // validate
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  try {
    const id = await downloadManager.addDownload({ url, ...rest });
    res.status(201).json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/downloads/:id/pause', (req, res) => {
  try {
    downloadManager.pauseDownload(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/downloads/:id/resume', (req, res) => {
  try {
    downloadManager.resumeDownload(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/downloads/:id/cancel', (req, res) => {
  try {
    downloadManager.cancelDownload(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/downloads/:id', (req, res) => {
  const deleteFile = req.query.deleteFile === 'true';
  try {
    downloadManager.deleteDownload(req.params.id, deleteFile);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Settings ──────────────────────────────────────────────────────────────────

app.get('/settings', (_req, res) => {
  try {
    const q = getStatements();
    const rows = q.getAllSettings.all();
    res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/settings', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key is required' });
  try {
    const q = getStatements();
    q.setSetting.run({ key, value: String(value) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── URL probe ─────────────────────────────────────────────────────────────────

app.post('/probe', async (req, res) => {
  const { url, headers } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const info = await networkUtils.probeUrl(url, headers || {});
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/stats', (_req, res) => {
  try {
    const q = getStatements();
    res.json({ history: q.getStats.all(), totals: q.getTotalStats.get() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Socket.IO ───────────────────────────────────────────────────────────────

function setupSocketIO(server) {
  io = new SocketIO(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    logger.debug('Socket.IO client connected', { id: socket.id });

    // Send current downloads on connect
    socket.emit('downloads:init', downloadManager.getAll());

    socket.on('disconnect', () => {
      logger.debug('Socket.IO client disconnected', { id: socket.id });
    });
  });

  // Relay download updates to all connected socket clients
  downloadManager.on('update', (id, changes) => {
    io.emit('download:update', { id, changes });
  });
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function start() {
  httpServer = http.createServer(app);
  setupSocketIO(httpServer);

  httpServer.listen(PORT, '127.0.0.1', () => {
    logger.info(`Nexus API server listening on http://127.0.0.1:${PORT}`);
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Port ${PORT} in use – Nexus server not started`);
    } else {
      logger.error('Server error', { err: err.message });
    }
  });
}

function stop() {
  if (httpServer) {
    httpServer.close(() => logger.info('Nexus API server stopped'));
    httpServer = null;
  }
}

module.exports = { app, start, stop };
