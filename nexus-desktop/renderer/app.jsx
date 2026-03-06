// nexus-desktop/renderer/app.jsx
// Root application component – loaded by index.html via Babel standalone
// All components are loaded as separate <script type="text/babel"> tags.

const { useState, useEffect, useCallback, useReducer, useRef } = React;

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = ['all', 'video', 'audio', 'document', 'image', 'archive', 'application', 'other'];
const STATUS_FILTERS = ['all', 'downloading', 'completed', 'paused', 'error'];

// ─── State management (simple useReducer) ─────────────────────────────────────

const initialState = {
  downloads: [],
  activeCategory: 'all',
  activeStatus: 'all',
  searchQuery: '',
  showAddModal: false,
  showPlaylistModal: false,
  notifications: [],
  stats: { history: [], totals: { total_bytes: 0, total_count: 0 } },
  settings: {},
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_DOWNLOADS':
      return { ...state, downloads: action.payload };

    case 'UPDATE_DOWNLOAD': {
      const { id, changes } = action.payload;
      if (changes.deleted) {
        return { ...state, downloads: state.downloads.filter((d) => d.id !== id) };
      }
      return {
        ...state,
        downloads: state.downloads.map((d) =>
          d.id === id ? { ...d, ...changes } : d
        ),
      };
    }

    case 'SET_CATEGORY':
      return { ...state, activeCategory: action.payload };

    case 'SET_STATUS':
      return { ...state, activeStatus: action.payload };

    case 'SET_SEARCH':
      return { ...state, searchQuery: action.payload };

    case 'TOGGLE_ADD_MODAL':
      return { ...state, showAddModal: !state.showAddModal };

    case 'TOGGLE_PLAYLIST_MODAL':
      return { ...state, showPlaylistModal: !state.showPlaylistModal };

    case 'ADD_NOTIFICATION':
      return { ...state, notifications: [...state.notifications, action.payload] };

    case 'REMOVE_NOTIFICATION':
      return { ...state, notifications: state.notifications.filter((n) => n.id !== action.payload) };

    case 'SET_STATS':
      return { ...state, stats: action.payload };

    case 'SET_SETTINGS':
      return { ...state, settings: action.payload };

    default:
      return state;
  }
}

// ─── Root Component ───────────────────────────────────────────────────────────

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const unsubRef = useRef(null);

  // Load initial data
  useEffect(() => {
    loadDownloads();
    loadStats();
    loadSettings();

    // Subscribe to live download updates
    if (window.nexus?.download?.onUpdate) {
      unsubRef.current = window.nexus.download.onUpdate(({ id, changes }) => {
        dispatch({ type: 'UPDATE_DOWNLOAD', payload: { id, changes } });
      });
    }

    return () => {
      if (unsubRef.current) unsubRef.current();
    };
  }, []);

  async function loadDownloads() {
    try {
      const dls = await window.nexus?.download?.getAll?.() ?? [];
      dispatch({ type: 'SET_DOWNLOADS', payload: dls });
    } catch (err) {
      notify('error', 'Failed to load downloads: ' + err.message);
    }
  }

  async function loadStats() {
    try {
      const s = await window.nexus?.stats?.get?.() ?? initialState.stats;
      dispatch({ type: 'SET_STATS', payload: s });
    } catch (_) {}
  }

  async function loadSettings() {
    try {
      const s = await window.nexus?.settings?.getAll?.() ?? {};
      dispatch({ type: 'SET_SETTINGS', payload: s });
    } catch (_) {}
  }

  const notify = useCallback((type, message) => {
    const id = Date.now().toString();
    dispatch({ type: 'ADD_NOTIFICATION', payload: { id, type, message } });
    setTimeout(() => dispatch({ type: 'REMOVE_NOTIFICATION', payload: id }), 5000);
  }, []);

  // ─── Filtered downloads ────────────────────────────────────────────────────

  const filteredDownloads = state.downloads.filter((d) => {
    if (state.activeCategory !== 'all' && d.category !== state.activeCategory) return false;
    if (state.activeStatus !== 'all' && d.status !== state.activeStatus) return false;
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      if (!d.title?.toLowerCase().includes(q) && !d.url?.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // ─── Download actions ──────────────────────────────────────────────────────

  const handleAddDownload = useCallback(async (opts) => {
    try {
      const id = await window.nexus?.download?.add?.(opts);
      notify('success', 'Download added!');
      await loadDownloads();
      return id;
    } catch (err) {
      notify('error', 'Add failed: ' + err.message);
    }
  }, []);

  const handleAction = useCallback(async (action, id) => {
    const api = window.nexus?.download;
    try {
      if (action === 'pause')  await api?.pause?.(id);
      if (action === 'resume') await api?.resume?.(id);
      if (action === 'cancel') await api?.cancel?.(id);
      if (action === 'delete') { await api?.delete?.(id, false); dispatch({ type: 'UPDATE_DOWNLOAD', payload: { id, changes: { deleted: true } } }); }
      if (action === 'open')   await window.nexus?.shell?.openFile?.(id);
      if (action === 'folder') await window.nexus?.shell?.showInFolder?.(id);
    } catch (err) {
      notify('error', err.message);
    }
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full" style={{ userSelect: 'none' }}>
      <TitleBar onAddClick={() => dispatch({ type: 'TOGGLE_ADD_MODAL' })} />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          categories={CATEGORIES}
          statusFilters={STATUS_FILTERS}
          activeCategory={state.activeCategory}
          activeStatus={state.activeStatus}
          downloads={state.downloads}
          onCategoryChange={(c) => dispatch({ type: 'SET_CATEGORY', payload: c })}
          onStatusChange={(s) => dispatch({ type: 'SET_STATUS', payload: s })}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          <StatsBar stats={state.stats} downloads={state.downloads} />

          <DownloadList
            downloads={filteredDownloads}
            searchQuery={state.searchQuery}
            onSearchChange={(q) => dispatch({ type: 'SET_SEARCH', payload: q })}
            onAction={handleAction}
          />
        </main>
      </div>

      {state.showAddModal && (
        <AddDownloadModal
          onAdd={handleAddDownload}
          onClose={() => dispatch({ type: 'TOGGLE_ADD_MODAL' })}
        />
      )}

      {state.showPlaylistModal && (
        <PlaylistModal
          onAdd={handleAddDownload}
          onClose={() => dispatch({ type: 'TOGGLE_PLAYLIST_MODAL' })}
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
