// nexus-desktop/renderer/components/PlaylistModal.jsx
// Full playlist modal:
//   Loading:  spinner + "Fetching playlist info..."
//   Loaded:   thumbnail, title, stats, quality selector, options, video preview list

const QUALITY_OPTIONS = ['Best', '4K', '1080p', '720p', '480p', '360p', 'Audio Only'];

function PlaylistModal({ onAdd, onClose }) {
  const { useState, useEffect, useRef } = React;

  const [playlistUrl, setPlaylistUrl] = useState('');
  const [saveDir,     setSaveDir]     = useState('');
  const [quality,     setQuality]     = useState('Best');
  const [subtitles,   setSubtitles]   = useState(false);
  const [subfolder,   setSubfolder]   = useState(true);
  const [numberFiles, setNumberFiles] = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [fetching,    setFetching]    = useState(false);
  const [error,       setError]       = useState('');
  const [info,        setInfo]        = useState(null);   // playlist info from yt-dlp

  const urlRef = useRef(null);

  useEffect(() => { if (urlRef.current) urlRef.current.focus(); }, []);

  const handleBrowse = async () => {
    const dir = await window.nexus?.dialog?.selectFolder?.()
      ?? await window.electron?.browseFolder?.();
    if (dir) setSaveDir(dir);
  };

  const handleFetch = async () => {
    const trimmed = playlistUrl.trim();
    if (!trimmed) { setError('Enter a playlist URL'); return; }
    try { new URL(trimmed); } catch (_) { setError('Invalid URL'); return; }

    setFetching(true);
    setError('');
    setInfo(null);
    try {
      const result = await window.nexus?.getPlaylistInfo?.(trimmed)
        ?? await window.electron?.getPlaylistInfo?.(trimmed);
      if (!result) throw new Error('Could not fetch playlist info');
      setInfo(result);
    } catch (err) {
      setError('Failed to fetch playlist: ' + (err.message || 'Unknown error'));
    } finally {
      setFetching(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && !info && !fetching) handleFetch();
  };

  const handleSubmit = async () => {
    if (!info) return;
    setLoading(true);
    setError('');
    try {
      const qualityVal = quality === 'Best' ? null
        : quality === 'Audio Only' ? 'bestaudio'
        : quality.toLowerCase();

      const saveTarget = subfolder && info.title
        ? (saveDir ? `${saveDir}/${info.title}` : info.title)
        : saveDir || undefined;

      if (info.entries && info.entries.length > 0) {
        await (window.nexus?.download?.addPlaylist ?? window.electron?.downloadPlaylist)?.({
          url:       playlistUrl.trim(),
          title:     info.title,
          entries:   info.entries,
          quality:   qualityVal,
          saveDir:   saveTarget,
          subtitles,
          numberFiles,
        });
      } else {
        await onAdd({
          url: playlistUrl.trim(),
          quality: qualityVal,
          saveDir: saveTarget,
          subtitles,
          isPlaylist: true,
        });
      }
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to add playlist');
    } finally {
      setLoading(false);
    }
  };

  const entryCount = info?.entries?.length || info?.entry_count || 0;
  const estSizeGB  = info?.estimated_size_gb
    ?? (entryCount * (quality === '4K' ? 4.0 : quality === '1080p' ? 1.2 : 0.4)).toFixed(1);

  return (
    <div className="modal-backdrop" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="modal" style={{ width: 'min(560px, 92vw)', maxHeight: '85vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">⚡ Download Playlist</div>

        {/* URL row */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            ref={urlRef}
            className="input"
            type="url"
            placeholder="https://youtube.com/playlist?list=…"
            value={playlistUrl}
            onChange={(e) => { setPlaylistUrl(e.target.value); setInfo(null); setError(''); }}
            style={{ flex: 1, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
          />
          <button
            className="btn btn-primary"
            onClick={handleFetch}
            disabled={fetching || !playlistUrl.trim()}
            style={{ flexShrink: 0, background: 'var(--accent2)', color: '#000' }}
          >
            {fetching ? '…' : 'Analyze'}
          </button>
        </div>

        {/* Loading state */}
        {fetching && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 0', color: 'var(--text-2)', fontSize: 13 }}>
            <div className="spinner" />
            <span>Fetching playlist info…</span>
          </div>
        )}

        {/* Loaded state */}
        {info && !fetching && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Thumbnail + title */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {info.thumbnail && (
                <img
                  src={info.thumbnail}
                  alt="thumbnail"
                  style={{ width: 100, height: 60, objectFit: 'cover', borderRadius: 6, flexShrink: 0, border: '1px solid var(--border)' }}
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
              )}
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-1)', marginBottom: 4 }}>
                  {info.title || 'Untitled Playlist'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: "'JetBrains Mono', monospace" }}>
                  {entryCount} videos  •  ~{estSizeGB} GB estimated at {quality}
                </div>
              </div>
            </div>

            {/* Quality selector */}
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-2)', display: 'block', marginBottom: 8 }}>
                Quality
              </label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {QUALITY_OPTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => setQuality(q)}
                    style={{
                      padding: '5px 12px', borderRadius: 8, border: '1px solid',
                      borderColor: quality === q ? 'var(--accent)' : 'var(--border)',
                      background:  quality === q ? 'rgba(0,255,136,0.12)' : 'var(--bg-3)',
                      color:       quality === q ? 'var(--accent)' : 'var(--text-2)',
                      fontSize: 12, fontWeight: quality === q ? 700 : 400,
                      cursor: 'pointer', transition: 'all .12s',
                    }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>

            {/* Options checkboxes */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                [subtitles,   setSubtitles,   'Download subtitles automatically'],
                [subfolder,   setSubfolder,   'Create subfolder with playlist name'],
                [numberFiles, setNumberFiles, 'Number files (01-title, 02-title, …)'],
              ].map(([val, setter, label]) => (
                <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-1)' }}>
                  <input
                    type="checkbox"
                    checked={val}
                    onChange={(e) => setter(e.target.checked)}
                    style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
                  />
                  {label}
                </label>
              ))}
            </div>

            {/* Save to */}
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-2)', display: 'block', marginBottom: 6 }}>
                Save to
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="input"
                  type="text"
                  placeholder="Default downloads folder"
                  value={saveDir}
                  onChange={(e) => setSaveDir(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button type="button" className="btn btn-ghost" onClick={handleBrowse} style={{ flexShrink: 0 }}>Browse</button>
              </div>
            </div>

            {/* Video preview list (first 5 + "and N more") */}
            {info.entries && info.entries.length > 0 && (
              <div style={{ background: 'var(--bg-3)', borderRadius: 8, overflow: 'hidden' }}>
                {info.entries.slice(0, 5).map((entry, i) => (
                  <div
                    key={entry.id || i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                      borderBottom: i < Math.min(4, info.entries.length - 1) ? '1px solid var(--border)' : 'none',
                    }}
                  >
                    <span style={{ fontSize: 11, color: 'var(--text-2)', fontFamily: "'JetBrains Mono', monospace", minWidth: 24 }}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    {entry.thumbnail && (
                      <img
                        src={entry.thumbnail}
                        alt=""
                        style={{ width: 48, height: 28, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    )}
                    <span style={{ fontSize: 12, color: 'var(--text-1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.title || `Video ${i + 1}`}
                    </span>
                    {entry.duration && (
                      <span style={{ fontSize: 11, color: 'var(--text-2)', fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
                        {entry.duration}
                      </span>
                    )}
                  </div>
                ))}
                {info.entries.length > 5 && (
                  <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-2)', textAlign: 'center' }}>
                    …and {info.entries.length - 5} more videos
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ fontSize: 12, color: 'var(--red)', padding: '8px 10px', background: 'rgba(255,68,68,0.08)', borderRadius: 8, marginTop: 12, borderLeft: '2px solid var(--red)' }}>
            {error}
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading || fetching}>
            Cancel
          </button>
          {info ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={loading}
            >
              {loading ? 'Adding…' : `⚡ Download All (${entryCount})`}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleFetch}
              disabled={fetching || !playlistUrl.trim()}
              style={{ background: 'var(--accent2)', color: '#000' }}
            >
              {fetching ? 'Analyzing…' : 'Analyze Playlist'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
