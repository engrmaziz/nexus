// nexus-desktop/renderer/components/PlaylistModal.jsx

function PlaylistModal({ onAdd, onClose }) {
  const { useState } = React;

  const [playlistUrl, setPlaylistUrl] = useState('');
  const [saveDir, setSaveDir] = useState('');
  const [quality, setQuality] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleBrowse = async () => {
    const dir = await window.nexus?.dialog?.selectFolder?.();
    if (dir) setSaveDir(dir);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = playlistUrl.trim();
    if (!trimmed) { setError('Enter a playlist URL'); return; }
    try { new URL(trimmed); } catch (_) { setError('Invalid URL'); return; }

    const startN = parseInt(start, 10) || 1;
    const endN = parseInt(end, 10) || null;

    if (endN && endN < startN) { setError('End item must be ≥ start'); return; }

    setLoading(true);
    setError('');
    try {
      await onAdd({
        url: trimmed,
        saveDir: saveDir || undefined,
        quality: quality || undefined,
        isPlaylist: true,
        extraArgs: [
          '--playlist-start', String(startN),
          ...(endN ? ['--playlist-end', String(endN)] : []),
        ],
      });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Download Playlist</div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Playlist URL *</label>
            <input
              className="input"
              type="url"
              placeholder="https://youtube.com/playlist?list=..."
              value={playlistUrl}
              onChange={(e) => setPlaylistUrl(e.target.value)}
              autoFocus
              required
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Save to</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" type="text" placeholder="Default downloads folder" value={saveDir} onChange={(e) => setSaveDir(e.target.value)} style={{ flex: 1 }} />
              <button type="button" className="btn btn-ghost" onClick={handleBrowse}>Browse</button>
            </div>
          </div>

          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Quality</label>
            <select className="input" value={quality} onChange={(e) => setQuality(e.target.value)}>
              <option value="">Best</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
              <option value="360p">360p</option>
            </select>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Start item</label>
              <input className="input" type="number" min="1" placeholder="1" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>End item (optional)</label>
              <input className="input" type="number" min="1" placeholder="All" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>

          {error && (
            <div style={{ fontSize: 12, color: 'var(--error)', padding: '6px 10px', background: 'rgba(248,113,113,.1)', borderRadius: 6 }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Adding…' : 'Download Playlist'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
