// nexus-desktop/renderer/components/DownloadCard.jsx

const STATUS_COLORS = {
  downloading: 'var(--accent)',
  completed:   'var(--success)',
  paused:      'var(--warning)',
  error:       'var(--error)',
  queued:      'var(--text-muted)',
  cancelled:   'var(--text-muted)',
  merging:     '#a78bfa',
  pending:     'var(--text-muted)',
};

function formatBytes(b) {
  if (!b) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatEta(secs) {
  if (!secs || secs <= 0 || !isFinite(secs)) return '--';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function DownloadCard({ download, onAction }) {
  const { useState } = React;
  const [hovered, setHovered] = useState(false);

  const {
    id, title, filename, status, progress = 0,
    downloaded = 0, file_size = 0, speed = 0,
    eta = 0, category, error_msg, save_path,
  } = download;

  const statusColor = STATUS_COLORS[status] || 'var(--text-muted)';
  const isActive = status === 'downloading';
  const isDone = status === 'completed';
  const isPaused = status === 'paused';
  const isError = status === 'error';

  const handleOpen = () => onAction?.('open', save_path ? `${save_path}/${filename}` : filename);
  const handleFolder = () => onAction?.('folder', save_path ? `${save_path}/${filename}` : filename);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'var(--surface2)' : 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '12px 14px',
        transition: 'background .15s',
        cursor: 'default',
      }}
    >
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <CategoryIcon category={category} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="truncate" style={{ fontWeight: 500, fontSize: 13 }}>
            {title || filename || 'Unknown'}
          </div>
          <div className="truncate text-sm text-muted" style={{ marginTop: 2 }}>
            {isDone ? formatBytes(file_size) : `${formatBytes(downloaded)} / ${formatBytes(file_size)}`}
            {isActive && speed > 0 && ` · ${formatBytes(speed)}/s · ETA ${formatEta(eta)}`}
          </div>
        </div>

        {/* Status badge */}
        <span style={{ fontSize: 11, fontWeight: 600, color: statusColor, whiteSpace: 'nowrap', paddingTop: 2 }}>
          {status.toUpperCase()}
        </span>
      </div>

      {/* Progress bar */}
      {!isDone && !isError && (
        <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginBottom: 8 }}>
          <div
            style={{
              height: '100%',
              width: `${Math.min(100, progress)}%`,
              background: statusColor,
              borderRadius: 2,
              transition: 'width .5s',
            }}
          />
        </div>
      )}

      {/* Error message */}
      {isError && error_msg && (
        <div style={{ fontSize: 11, color: 'var(--error)', marginBottom: 8, padding: '4px 8px', background: 'rgba(248,113,113,.1)', borderRadius: 4 }}>
          {error_msg}
        </div>
      )}

      {/* Action buttons */}
      {hovered && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {isActive && (
            <ActionBtn onClick={() => onAction?.('pause', id)} color="var(--warning)">⏸ Pause</ActionBtn>
          )}
          {isPaused && (
            <ActionBtn onClick={() => onAction?.('resume', id)} color="var(--accent)">▶ Resume</ActionBtn>
          )}
          {(isActive || isPaused) && (
            <ActionBtn onClick={() => onAction?.('cancel', id)} color="var(--error)">✕ Cancel</ActionBtn>
          )}
          {isDone && (
            <>
              <ActionBtn onClick={handleOpen} color="var(--success)">▶ Open</ActionBtn>
              <ActionBtn onClick={handleFolder} color="var(--text-muted)">📁 Folder</ActionBtn>
            </>
          )}
          {isError && (
            <ActionBtn onClick={() => onAction?.('resume', id)} color="var(--accent)">↺ Retry</ActionBtn>
          )}
          {isDone && (
            <ActionBtn onClick={() => onAction?.('delete', id)} color="var(--error)">🗑 Delete</ActionBtn>
          )}
        </div>
      )}
    </div>
  );
}

function CategoryIcon({ category }) {
  const icons = { video: '🎬', audio: '🎵', document: '📄', image: '🖼️', archive: '📦', application: '⚙️' };
  const icon = icons[category] || '📎';
  return (
    <div style={{
      width: 36, height: 36, borderRadius: 8,
      background: 'var(--surface2)', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontSize: 18, flexShrink: 0,
    }}>
      {icon}
    </div>
  );
}

function ActionBtn({ onClick, color, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 10px', borderRadius: 5, border: `1px solid ${color}20`,
        background: `${color}15`, color, fontSize: 11, cursor: 'pointer',
        fontWeight: 500, transition: 'background .15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = `${color}30`; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = `${color}15`; }}
    >
      {children}
    </button>
  );
}
