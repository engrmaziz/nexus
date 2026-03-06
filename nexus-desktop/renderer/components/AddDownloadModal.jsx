// nexus-desktop/renderer/components/AddDownloadModal.jsx

function AddDownloadModal({ onAdd, onClose }) {
  const { useState, useRef } = React;

  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [saveDir, setSaveDir] = useState('');
  const [quality, setQuality] = useState('');
  const [subtitles, setSubtitles] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const urlRef = useRef(null);

  // Auto-focus URL field
  const focusRef = (el) => { if (el) el.focus(); };

  const handleBrowse = async () => {
    const dir = await window.nexus?.dialog?.selectFolder?.();
    if (dir) setSaveDir(dir);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) { setError('Please enter a URL'); return; }
    try { new URL(trimmedUrl); } catch (_) { setError('Invalid URL'); return; }

    setLoading(true);
    setError('');
    try {
      await onAdd({
        url: trimmedUrl,
        filename: filename.trim() || undefined,
        saveDir: saveDir || undefined,
        quality: quality || undefined,
        subtitles,
      });
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to add download');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="modal-backdrop" onKeyDown={handleKeyDown}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">New Download</div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* URL */}
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>URL *</label>
            <input
              ref={focusRef}
              className="input"
              type="url"
              placeholder="https://example.com/file.mp4"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </div>

          {/* Save to */}
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Save to</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input"
                type="text"
                placeholder="Default downloads folder"
                value={saveDir}
                onChange={(e) => setSaveDir(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" className="btn btn-ghost" onClick={handleBrowse} style={{ flexShrink: 0 }}>
                Browse
              </button>
            </div>
          </div>

          {/* Filename override */}
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Filename (optional)</label>
            <input
              className="input"
              type="text"
              placeholder="Leave blank to auto-detect"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
            />
          </div>

          {/* Quality */}
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Quality (video)</label>
            <select
              className="input"
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
            >
              <option value="">Best available</option>
              <option value="4k">4K (2160p)</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
              <option value="360p">360p</option>
            </select>
          </div>

          {/* Subtitles */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={subtitles}
              onChange={(e) => setSubtitles(e.target.checked)}
              style={{ accentColor: 'var(--accent)' }}
            />
            Download subtitles (if available)
          </label>

          {/* Error */}
          {error && (
            <div style={{ fontSize: 12, color: 'var(--error)', padding: '6px 10px', background: 'rgba(248,113,113,.1)', borderRadius: 6 }}>
              {error}
            </div>
          )}

          {/* Buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Adding…' : 'Download'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
