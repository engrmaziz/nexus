'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server: SocketIO } = require('socket.io');

const ytdlpEngine = require('./engine/ytdlpEngine');
const { getStatements } = require('./db/queries');
const networkUtils = require('./utils/networkUtils');
const logger = require('./utils/logger');
const nameCleaner = require('./ai/nameCleaner');
const categorizer = require('./ai/categorizer');

// downloadManager is injected via startServer() to ensure the same instance
// created in main.js is used here (avoids undefined / circular-dep issues).
let downloadManager = null;

const PORTS_TO_TRY = [6543, 6544, 6545];
const VERSION = process.env.npm_package_version || '1.0.0';
// Rough estimate for playlist size: 5 MB per minute at 720p
const ESTIMATED_BYTES_PER_SECOND = (5 * 1024 * 1024) / 60;

let httpServer = null;
let io = null;
let activePort = null;

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
app.use(cors({ origin: '*' }));
app.use(morgan('dev', { stream: { write: (m) => logger.debug(m.trim()) } }));
app.use(express.json({ limit: '10mb' }));

// ─── Routes ───────────────────────────────────────────────────────────────────

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok', version: VERSION }));

app.get('/api/health', (_req, res) => {
  const allDls = downloadManager.getAll ? downloadManager.getAll() : [];
  const activeDownloads = allDls.filter((d) => d.status === 'downloading').length;
  res.json({
    status: 'running',
    version: VERSION,
    port: activePort,
    activeDownloads,
    uptime: process.uptime(),
  });
});

// ── Downloads (legacy) ────────────────────────────────────────────────────────

app.get('/downloads', (_req, res) => {
  try {
    res.json(downloadManager.getAll ? downloadManager.getAll() : []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/downloads/:id', (req, res) => {
  const dl = downloadManager.getOne ? downloadManager.getOne(req.params.id) : null;
  if (!dl) return res.status(404).json({ error: 'Not found' });
  res.json(dl);
});

app.post('/downloads', async (req, res) => {
  const { url, ...rest } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try { new URL(url); } catch (_) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  try {
    const addFn = downloadManager.add.bind(downloadManager);
    const id = await addFn({ url, ...rest });
    res.status(201).json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/downloads/:id/pause', (req, res) => {
  try {
    if (downloadManager.pauseDownload) downloadManager.pauseDownload(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/downloads/:id/resume', (req, res) => {
  try {
    if (downloadManager.resumeDownload) downloadManager.resumeDownload(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/downloads/:id/cancel', (req, res) => {
  try {
    if (downloadManager.cancelDownload) downloadManager.cancelDownload(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/downloads/:id', (req, res) => {
  const deleteFile = req.query.deleteFile === 'true';
  try {
    if (downloadManager.deleteDownload) downloadManager.deleteDownload(req.params.id, deleteFile);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/download – primary endpoint for Chrome extension ─────────────────

app.post('/api/download', async (req, res) => {
  const { url, filename, fileSize, mimeType, type, pageUrl, pageTitle,
          quality, stream, allStreams } = req.body;

  // 1. Validate URL
  if (!url) return res.status(400).json({ error: 'url is required' });

  // Validate downloadManager is ready
  if (!downloadManager) {
    return res.status(503).json({ error: 'Download manager not ready' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    // 2. Determine download type
    let resolvedType = type;
    if (!resolvedType) {
      const urlHost = parsedUrl.hostname.toLowerCase();
      if (stream) {
        resolvedType = stream.type === 'hls' ? 'hls' : (stream.type === 'dash' ? 'dash' : 'video');
      } else if (urlHost === 'youtube.com' || urlHost === 'www.youtube.com' ||
                 urlHost === 'youtu.be' || urlHost === 'm.youtube.com') {
        resolvedType = 'yt';
      } else if (mimeType) {
        if (mimeType.startsWith('video/') || mimeType.startsWith('application/x-mpegURL')) {
          resolvedType = 'video';
        } else if (mimeType.startsWith('audio/')) {
          resolvedType = 'audio';
        } else {
          resolvedType = 'file';
        }
      } else {
        const ext = path.extname(parsedUrl.pathname).toLowerCase();
        const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m3u8', '.mpd'];
        resolvedType = videoExts.includes(ext) ? 'video' : 'file';
      }
    }

    // 3. AI Smart Naming
    // Prefer pageTitle over filename; never fall back to a bare URL path segment
    // that would be meaningless as a filename (e.g. "watch" for youtube.com/watch?v=xxx).
    // We also skip a filename that merely echoes the URL basename (it adds no information
    // beyond what we'd get from the URL itself) to avoid redundant/unhelpful names.
    const urlBasename = path.basename(parsedUrl.pathname);
    const isMeaninglessBasename = !urlBasename || urlBasename === 'watch' ||
      urlBasename === 'video' || urlBasename === 'embed' || urlBasename === 'v';
    // Use provided filename only when it differs from the URL's own basename, meaning
    // it was explicitly set (e.g. from a Content-Disposition header) rather than derived
    // directly from the URL path.
    const rawName = pageTitle ||
      (filename && filename !== urlBasename ? filename : '') ||
      (!isMeaninglessBasename ? urlBasename : '') ||
      'download';
    const cleanName = nameCleaner.cleanFromUrl
      ? nameCleaner.cleanFromUrl(rawName, url, { quality, pageTitle })
      : nameCleaner.clean(rawName);

    // 4. AI Categorization
    const catResult = categorizer.categorizeDetailed
      ? categorizer.categorizeDetailed(cleanName, mimeType, url)
      : { category: categorizer.categorize(cleanName, mimeType, url), suggestedFolder: null };

    // 5. Add to download queue
    const isVideo = resolvedType === 'video' || resolvedType === 'hls' ||
      resolvedType === 'dash' || resolvedType === 'audio' || resolvedType === 'yt';
    const addFn = downloadManager.add.bind(downloadManager);
    const downloadId = await addFn({
      url:      (stream && stream.url) || url,
      filename: cleanName,
      fileSize: fileSize || 0,
      mimeType: mimeType || '',
      type:     resolvedType,
      referrer: pageUrl || '',
      isYtdlp:  isVideo,
      quality:  quality || (isVideo ? 'best' : null),
      category: catResult.category,
      saveDir:  catResult.suggestedFolder || undefined,
      pageTitle: pageTitle || '',
      pageUrl:   pageUrl   || '',
    });

    res.json({ success: true, downloadId, message: 'Download queued' });
  } catch (err) {
    logger.error('POST /api/download failed', err.message, err.stack);
    res.status(500).json({ error: _friendlyError(err) });
  }
});

// ── GET /api/settings ─────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  try {
    const q = getStatements();
    const rows = q.getAllSettings.all();
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    // Return only extension-relevant settings
    const relevant = {
      interceptSize:  settings.intercept_size || '0',
      fileTypes:      settings.file_types || '',
      autoStart:      settings.auto_start || '1',
      maxConcurrent:  settings.max_concurrent || '3',
      saveDir:        settings.save_dir || '',
    };
    res.json(relevant);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Settings (legacy) ─────────────────────────────────────────────────────────

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

// ── POST /api/playlist/info ───────────────────────────────────────────────────

app.post('/api/playlist/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const info = await ytdlpEngine.getPlaylistInfo(url);
    // Estimate total size from known durations (rough: 5 MB/min at 720p)
    const estimatedSize = info.entries.reduce((sum, e) => sum + (e.duration || 0) * ESTIMATED_BYTES_PER_SECOND, 0);
    res.json({
      title: info.title,
      count: info.count,
      entries: info.entries,
      estimatedSize: Math.round(estimatedSize),
    });
  } catch (err) {
    logger.error('POST /api/playlist/info failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/playlist/download ───────────────────────────────────────────────

app.post('/api/playlist/download', async (req, res) => {
  const { url, quality, title, entries } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const { v4: uuidv4 } = require('uuid');
    const playlistId = uuidv4();
    const addFn = downloadManager.add.bind(downloadManager);
    const list = Array.isArray(entries) && entries.length > 0 ? entries : [{ url, title }];
    let queuedCount = 0;
    for (const entry of list) {
      try {
        await addFn({
          url: entry.url || url,
          filename: entry.title ? nameCleaner.clean(entry.title) : undefined,
          quality: quality || 'best',
          isYtdlp: true,
          playlistId,
        });
        queuedCount++;
      } catch (e) {
        logger.warn('Failed to queue playlist entry', { url: entry.url, err: e.message });
      }
    }
    res.json({ success: true, queuedCount, playlistId });
  } catch (err) {
    logger.error('POST /api/playlist/download failed', { err: err.message });
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _friendlyError(err) {
  const msg = err && err.message ? err.message : String(err);
  try {
    const { getUserFriendlyMessage } = require('./utils/errorHandler');
    return getUserFriendlyMessage(err);
  } catch (_) {
    return msg || 'An unexpected error occurred.';
  }
}

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
    socket.emit('downloads:init', downloadManager.getAll ? downloadManager.getAll() : []);

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

function _savePort(port) {
  try {
    const { app: electronApp } = require('electron');
    const portFile = path.join(electronApp.getPath('userData'), 'port.txt');
    fs.writeFileSync(portFile, String(port), 'utf8');
  } catch (_) {}
}

function _tryListen(server, port) {
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(port));
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') reject(err);
      else reject(err);
    });
  });
}

async function start() {
  for (const port of PORTS_TO_TRY) {
    try {
      httpServer = http.createServer(app);
      setupSocketIO(httpServer);
      await _tryListen(httpServer, port);
      activePort = port;
      logger.info(`Nexus API server listening on http://127.0.0.1:${port}`);
      _savePort(port);
      return;
    } catch (err) {
      // Clean up this server instance before trying next port
      try { httpServer.close(); } catch (_) {}
      if (io) { try { io.close(); } catch (_) {} io = null; }
      httpServer = null;

      if (err.code === 'EADDRINUSE') {
        logger.warn(`Port ${port} in use – trying next port`);
      } else {
        logger.error('Server error', { err: err.message });
        return;
      }
    }
  }

  logger.error('All ports in use. Nexus API server not started.');
}

async function startServer(dm) {
  downloadManager = dm;
  await start();
}

function stop() {
  if (httpServer) {
    httpServer.close(() => logger.info('Nexus API server stopped'));
    httpServer = null;
    activePort = null;
  }
}

module.exports = { app, startServer, stop, getActivePort: () => activePort };
