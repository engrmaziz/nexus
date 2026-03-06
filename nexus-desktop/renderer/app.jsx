// nexus-desktop/renderer/app.jsx
// Root application component – loaded by index.html via Babel standalone
// All components are loaded as separate <script type="text/babel"> tags
// (they must appear before this file in index.html).

const { useState, useEffect, useCallback, useReducer, useRef } = React;

// ─── Constants ────────────────────────────────────────────────────────────────

// activeFilter values match the spec: 'all'|'downloading'|'complete'|'queued'|'failed'|'paused'
const FILTER_VALUES = ['all', 'downloading', 'complete', 'queued', 'failed', 'paused'];

// ─── State management ─────────────────────────────────────────────────────────

const initialState = {
  downloads: [],
  activeFilter: 'all',        // 'all'|'downloading'|'complete'|'queued'|'failed'|'paused'
  searchQuery: '',
  totalSpeed: 0,              // sum of all active download speeds (bytes/s)
  showAddModal: false,
  showPlaylistModal: false,
  notifications: [],
  stats: { history: [], totals: { total_bytes: 0, total_count: 0 } },
  settings: {},
  isYtdlpInstalled: false,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_DOWNLOADS': {
      const downloads = action.payload;
      const totalSpeed = downloads
        .filter((d) => d.status === 'downloading')
        .reduce((acc, d) => acc + (d.speed || 0), 0);
      return { ...state, downloads, totalSpeed };
    }

    case 'UPDATE_DOWNLOAD': {
      const { id, changes } = action.payload;
      let downloads;
      if (changes.deleted) {
        downloads = state.downloads.filter((d) => d.id !== id);
      } else {
        const exists = state.downloads.some((d) => d.id === id);
        if (exists) {
          downloads = state.downloads.map((d) => d.id === id ? { ...d, ...changes } : d);
        } else {
          // New download came in via event
          downloads = [{ id, ...changes }, ...state.downloads];
        }
      }
      const totalSpeed = downloads
        .filter((d) => d.status === 'downloading')
        .reduce((acc, d) => acc + (d.speed || 0), 0);
      return { ...state, downloads, totalSpeed };
    }

    case 'SET_FILTER':
      return { ...state, activeFilter: action.payload };

    case 'SET_SEARCH':
      return { ...state, searchQuery: action.payload };

    case 'TOGGLE_ADD_MODAL':
      return { ...state, showAddModal: !state.showAddModal };

    case 'OPEN_ADD_MODAL':
      return { ...state, showAddModal: true };

    case 'CLOSE_ADD_MODAL':
      return { ...state, showAddModal: false };

    case 'TOGGLE_PLAYLIST_MODAL':
      return { ...state, showPlaylistModal: !state.showPlaylistModal };

    case 'CLOSE_PLAYLIST_MODAL':
      return { ...state, showPlaylistModal: false };

    case 'ADD_NOTIFICATION':
      return { ...state, notifications: [...state.notifications, action.payload] };

    case 'REMOVE_NOTIFICATION':
      return { ...state, notifications: state.notifications.filter((n) => n.id !== action.payload) };

    case 'SET_STATS':
      return { ...state, stats: action.payload };

    case 'SET_SETTINGS':
      return { ...state, settings: action.payload };

    case 'SET_YTDLP':
      return { ...state, isYtdlpInstalled: action.payload };

    default:
      return state;
  }
}

// ─── Root Component ───────────────────────────────────────────────────────────

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const unsubRef = useRef(null);

  // Load initial data and subscribe to live updates
  useEffect(() => {
    loadDownloads();
    loadStats();
    loadSettings();
    checkYtdlp();

    // Subscribe to live download updates via IPC
    if (window.nexus?.download?.onUpdate) {
      unsubRef.current = window.nexus.download.onUpdate(({ id, changes }) => {
        dispatch({ type: 'UPDATE_DOWNLOAD', payload: { id, changes } });
      });
    }

    // Also listen on window.electron events (secondary API)
    if (window.electron) {
      window.electron.onProgress((data) => {
        if (data && data.id) {
          dispatch({ type: 'UPDATE_DOWNLOAD', payload: { id: data.id, changes: {
            status: 'downloading',
            downloaded: data.downloaded,
            progress: data.progress,
            speed: data.speed,
            eta: data.eta,
          }}});
        }
      });
      window.electron.onComplete((data) => {
        if (data && data.id) {
          dispatch({ type: 'UPDATE_DOWNLOAD', payload: { id: data.id, changes: { status: 'completed', progress: 100 } } });
        }
      });
      window.electron.onError((data) => {
        if (data && data.id) {
          dispatch({ type: 'UPDATE_DOWNLOAD', payload: { id: data.id, changes: {
            status: 'error', error_msg: data.error || data.message || 'Unknown error',
          }}});
        }
      });
      window.electron.onNew((data) => {
        if (data && data.id) loadDownloads();
      });
    }

    // yt-dlp install-progress banner
    if (window.nexus?.ytdlp?.onInstallProgress) {
      window.nexus.ytdlp.onInstallProgress((pct) => {
        notify('info', `Installing yt-dlp… ${pct}%`);
        if (pct >= 100) {
          dispatch({ type: 'SET_YTDLP', payload: true });
        }
      });
    }

    return () => {
      if (unsubRef.current) unsubRef.current();
      if (window.electron) {
        try {
          window.electron.removeAllListeners('dl:progress');
          window.electron.removeAllListeners('dl:complete');
          window.electron.removeAllListeners('dl:error');
          window.electron.removeAllListeners('dl:new');
          window.electron.removeAllListeners('dl:paused');
        } catch (_) {}
      }
    };
  }, []);

  async function loadDownloads() {
    try {
      const dls = await window.nexus?.download?.getAll?.()
        ?? await window.electron?.getDownloads?.()
        ?? [];
      dispatch({ type: 'SET_DOWNLOADS', payload: dls });
    } catch (err) {
      notify('error', 'Failed to load downloads: ' + err.message);
    }
  }

  async function loadStats() {
    try {
      const s = await window.nexus?.stats?.get?.()
        ?? await window.electron?.getStats?.()
        ?? initialState.stats;
      dispatch({ type: 'SET_STATS', payload: s });
    } catch (_) {}
  }

  async function loadSettings() {
    try {
      const s = await window.nexus?.settings?.getAll?.()
        ?? await window.electron?.getSettings?.()
        ?? {};
      dispatch({ type: 'SET_SETTINGS', payload: s });
    } catch (_) {}
  }

  async function checkYtdlp() {
    try {
      const installed = await window.nexus?.ytdlp?.check?.()
        ?? await window.electron?.checkYtdlp?.()
        ?? false;
      dispatch({ type: 'SET_YTDLP', payload: !!installed });
      if (!installed) {
        notify('info', 'Installing yt-dlp…');
        try {
          await window.nexus?.ytdlp?.install?.()
            ?? await window.electron?.installYtdlp?.();
          dispatch({ type: 'SET_YTDLP', payload: true });
          notify('success', 'yt-dlp installed successfully.');
        } catch (installErr) {
          notify('warning', 'yt-dlp install failed. Video downloads may not work.');
        }
      }
    } catch (_) {}
  }

  const notify = useCallback((type, message) => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2);
    dispatch({ type: 'ADD_NOTIFICATION', payload: { id, type, message } });
    setTimeout(() => dispatch({ type: 'REMOVE_NOTIFICATION', payload: id }), 5000);
  }, []);

  // ─── Filtered downloads ────────────────────────────────────────────────────

  const filteredDownloads = state.downloads.filter((d) => {
    const f = state.activeFilter;
    if (f !== 'all') {
      // Map filter name to status values
      const statusMap = {
        downloading: ['downloading'],
        complete:    ['completed'],
        queued:      ['queued', 'connecting', 'pending'],
        failed:      ['error', 'cancelled'],
        paused:      ['paused'],
      };
      const allowed = statusMap[f];
      if (allowed && !allowed.includes(d.status)) return false;
    }
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      if (!d.title?.toLowerCase().includes(q) && !d.url?.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // ─── Download actions ──────────────────────────────────────────────────────

  const handleAddDownload = useCallback(async (opts) => {
    try {
      const id = await window.nexus?.download?.add?.(opts)
        ?? await window.electron?.addDownload?.(opts);
      notify('success', 'Download added!');
      await loadDownloads();
      return id;
    } catch (err) {
      notify('error', 'Add failed: ' + err.message);
      throw err;
    }
  }, []);

  const handleAction = useCallback(async (action, id) => {
    const nexusApi = window.nexus?.download;
    const electronApi = window.electron;
    try {
      switch (action) {
        case 'pause':
          await nexusApi?.pause?.(id) ?? await electronApi?.pauseDownload?.(id);
          break;
        case 'resume':
          await nexusApi?.resume?.(id) ?? await electronApi?.resumeDownload?.(id);
          break;
        case 'cancel':
          await nexusApi?.cancel?.(id) ?? await electronApi?.cancelDownload?.(id);
          break;
        case 'retry':
          await nexusApi?.resume?.(id) ?? await electronApi?.retryDownload?.(id);
          break;
        case 'delete':
          await nexusApi?.delete?.(id, false) ?? await electronApi?.removeDownload?.(id);
          dispatch({ type: 'UPDATE_DOWNLOAD', payload: { id, changes: { deleted: true } } });
          break;
        case 'open':
          await window.nexus?.shell?.openFile?.(id) ?? await electronApi?.openFile?.(id);
          break;
        case 'folder':
          await window.nexus?.shell?.showInFolder?.(id) ?? await electronApi?.openFolder?.(id);
          break;
        case 'resumeAll':
          await nexusApi?.resumeAll?.() ?? await electronApi?.resumeAll?.();
          await loadDownloads();
          break;
        case 'pauseAll':
          await nexusApi?.pauseAll?.() ?? await electronApi?.pauseAll?.();
          await loadDownloads();
          break;
        default:
          break;
      }
    } catch (err) {
      notify('error', err.message);
    }
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', userSelect: 'none', overflow: 'hidden' }}>
      <TitleBar onAddClick={() => dispatch({ type: 'OPEN_ADD_MODAL' })} />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar
          downloads={state.downloads}
          activeFilter={state.activeFilter}
          stats={state.stats}
          totalSpeed={state.totalSpeed}
          onFilterChange={(f) => dispatch({ type: 'SET_FILTER', payload: f })}
          onAddClick={() => dispatch({ type: 'OPEN_ADD_MODAL' })}
          onResumeAll={() => handleAction('resumeAll', null)}
          onPauseAll={() => handleAction('pauseAll', null)}
          onSettingsClick={() => notify('info', 'Settings coming soon')}
        />

        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <StatsBar stats={state.stats} downloads={state.downloads} totalSpeed={state.totalSpeed} />

          <DownloadList
            downloads={filteredDownloads}
            searchQuery={state.searchQuery}
            onSearchChange={(q) => dispatch({ type: 'SET_SEARCH', payload: q })}
            onAction={handleAction}
          />

          <SpeedGraph downloads={state.downloads} totalSpeed={state.totalSpeed} />
        </main>
      </div>

      {state.showAddModal && (
        <AddDownloadModal
          onAdd={handleAddDownload}
          onClose={() => dispatch({ type: 'CLOSE_ADD_MODAL' })}
          onPlaylist={() => {
            dispatch({ type: 'CLOSE_ADD_MODAL' });
            dispatch({ type: 'TOGGLE_PLAYLIST_MODAL' });
          }}
        />
      )}

      {state.showPlaylistModal && (
        <PlaylistModal
          onAdd={handleAddDownload}
          onClose={() => dispatch({ type: 'CLOSE_PLAYLIST_MODAL' })}
        />
      )}

      <NotificationToast
        notifications={state.notifications}
        onDismiss={(id) => dispatch({ type: 'REMOVE_NOTIFICATION', payload: id })}
      />
    </div>
  );
}

// ─── Mount ────────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
