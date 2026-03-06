// nexus-desktop/renderer/components/AddDownloadModal.jsx
// Add Download modal with:
//   - URL input + Analyze button
//   - After analysis: quality grid (video) or file info + "Accelerate with N threads"
//   - Save to folder (Browse) + Filename (editable)
//   - [Cancel] [⚡ Start Download]

const VIDEO_SITES = [
  'youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com',
  'twitch.tv', 'facebook.com', 'instagram.com', 'tiktok.com',
  'twitter.com', 'x.com', 'soundcloud.com', 'reddit.com',
  'bilibili.com', 'nicovideo.jp',
];

function isVideoUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return VIDEO_SITES.some((d) => host === d || host.endsWith('.' + d));
  } catch (_) {
    return false;
  }
}

function AddDownloadModal({ onAdd, onClose, onPlaylist }) {
  const { useState, useRef, useEffect } = React;

  const [url,         setUrl]         = useState('');
  const [filename,    setFilename]     = useState('');
  const [saveDir,     setSaveDir]      = useState('');
  const [quality,     setQuality]      = useState('');
  const [subtitles,   setSubtitles]    = useState(false);
  const [loading,     setLoading]      = useState(false);
  const [analyzing,   setAnalyzing]    = useState(false);
  const [error,       setError]        = useState('');
  const [analysis,    setAnalysis]     = useState(null);  // { type: 'video'|'file', formats, filename, size, threads }

  const urlRef = useRef(null);

  useEffect(() => { if (urlRef.current) urlRef.current.focus(); }, []);

  const handleBrowse = async () => {
    const dir = await window.nexus?.dialog?.selectFolder?.()
      ?? await window.electron?.browseFolder?.();
    if (dir) setSaveDir(dir);
  };

  const handleAnalyze = async () => {
    const trimmed = url.trim();
    if (!trimmed) { setError('Please enter a URL'); return; }
    try { new URL(trimmed); } catch (_) { setError('Invalid URL'); return; }

    setAnalyzing(true);
    setError('');
    setAnalysis(null);

    try {
      if (isVideoUrl(trimmed)) {
        // Fetch available formats via yt-dlp
        const formats = await window.nexus?.getVideoFormats?.(trimmed)
          ?? await window.electron?.getVideoFormats?.(trimmed)
          ?? [];

        // Determine if playlist
        const isPlaylist = trimmed.includes('playlist') || trimmed.includes('list=');

        setAnalysis({ type: 'video', formats, isPlaylist });
        if (!quality && formats && formats.length > 0) {
          setQuality(formats[0]?.format_id || '');
        }
      } else {
        // Probe file headers
        const probed = await window.nexus?.download?.probe?.(trimmed)
          ?? { filename: decodeURIComponent(trimmed.split('/').pop().split('?')[0]) || 'download', size: 0, threads: 16 };

        setAnalysis({
          type: 'file',
          filename: probed.filename || probed.name || '',
          size: probed.size || 0,
          threads: probed.threads || 16,
          acceptsRanges: probed.acceptsRanges !== false,
        });
        if (!filename && probed.filename) setFilename(probed.filename);
      }
    } catch (err) {
      setError('Analysis failed: ' + (err.message || 'Unknown error'));
    } finally {
      setAnalyzing(false);
    }
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

  function fmtSize(b) {
    if (!b) return '';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  return (
    <div className="modal-backdrop" onKeyDown={handleKeyDown}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">⚡ New Download</div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* URL row */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-2)', display: 'block', marginBottom: 6 }}>
              URL *
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                ref={urlRef}
                className="input"
                type="url"
                placeholder="https://example.com/file.mp4"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setAnalysis(null); setError(''); }}
                style={{ flex: 1, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
                required
              />
              <button
                type="button"
                className="btn"
                onClick={handleAnalyze}
                disabled={analyzing || !url.trim()}
                style={{
                  flexShrink: 0, background: 'var(--bg-3)',
                  color: 'var(--accent2)', border: '1px solid var(--accent2)33',
                  fontSize: 12, fontWeight: 700,
                }}
              >
                {analyzing ? '…' : 'Analyze'}
              </button>
            </div>
          </div>

          {/* Analysis result panel */}
          {analyzing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg-3)', borderRadius: 8, fontSize: 13, color: 'var(--text-2)' }}>
              <div className="spinner" style={{ width: 16, height: 16 }} />
              <span>Analyzing URL…</span>
            </div>
          )}

          {analysis && analysis.type === 'video' && (
            <div style={{ background: 'var(--bg-3)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-2)', marginBottom: 8 }}>
                Video — Quality
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(analysis.formats && analysis.formats.length > 0
                  ? analysis.formats.slice(0, 8).map((f) => ({
                      id: f.format_id || f.format,
                      label: f.format_note || f.resolution || f.ext || f.format_id,
                    }))
                  : [
                      { id: '', label: 'Best' },
                      { id: '2160p', label: '4K' },
                      { id: '1080p', label: '1080p' },
                      { id: '720p', label: '720p' },
                      { id: '480p', label: '480p' },
                      { id: '360p', label: '360p' },
                    ]
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setQuality(opt.id)}
                    style={{
                      padding: '4px 10px', borderRadius: 7, border: '1px solid',
                      borderColor: quality === opt.id ? 'var(--accent)' : 'var(--border)',
                      background:  quality === opt.id ? 'rgba(0,255,136,0.12)' : 'var(--bg-2)',
                      color:       quality === opt.id ? 'var(--accent)' : 'var(--text-2)',
                      fontSize: 12, cursor: 'pointer', transition: 'all .12s',
                      fontWeight: quality === opt.id ? 700 : 400,
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {analysis.isPlaylist && onPlaylist && (
                <button
                  type="button"
                  onClick={onPlaylist}
                  style={{
                    marginTop: 10, fontSize: 12, color: 'var(--accent2)',
                    background: 'none', border: '1px solid var(--accent2)30',
                    padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                  }}
                >
                  📋 This looks like a playlist — Download Playlist instead
                </button>
              )}
            </div>
          )}

          {analysis && analysis.type === 'file' && (
            <div style={{ background: 'var(--bg-3)', borderRadius: 8, padding: '12px 14px', fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>{analysis.filename || 'File'}</div>
                  {analysis.size > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: "'JetBrains Mono', monospace", marginTop: 2 }}>
                      {fmtSize(analysis.size)}
                    </div>
                  )}
                </div>
                {analysis.acceptsRanges && (
                  <div style={{
                    fontSize: 11, color: 'var(--accent)', fontWeight: 700,
                    background: 'rgba(0,255,136,0.1)', padding: '4px 10px', borderRadius: 20,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>
                    ⚡ Accelerate with {analysis.threads} threads
                  </div>
                )}
              </div>
            </div>
          )}

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
              <button type="button" className="btn btn-ghost" onClick={handleBrowse} style={{ flexShrink: 0 }}>
                Browse
              </button>
            </div>
          </div>

          {/* Filename */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-2)', display: 'block', marginBottom: 6 }}>
              Filename
            </label>
            <input
              className="input"
              type="text"
              placeholder="Leave blank to auto-detect"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
            />
          </div>

          {/* Subtitles */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-1)' }}>
            <input
              type="checkbox"
              checked={subtitles}
              onChange={(e) => setSubtitles(e.target.checked)}
              style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
            />
            Download subtitles (if available)
          </label>

          {/* Error */}
          {error && (
            <div style={{ fontSize: 12, color: 'var(--red)', padding: '7px 10px', background: 'rgba(255,68,68,0.08)', borderRadius: 8, borderLeft: '2px solid var(--red)' }}>
              {error}
            </div>
          )}

          {/* Buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading || analyzing}>
              {loading ? 'Adding…' : '⚡ Start Download'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
