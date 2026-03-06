// nexus-desktop/renderer/components/DownloadCard.jsx
// Pixel-perfect download card per spec.

function formatBytes(b) {
  if (!b || b <= 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatEta(secs) {
  if (!secs || secs <= 0 || !isFinite(secs)) return '--';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function formatSpeed(b) {
  if (!b || b <= 0) return '0 B/s';
  return formatBytes(b) + '/s';
}

// Left border + badge colors
const STATUS_BORDER = {
  downloading: 'var(--accent3)',   // orange
  completed:   'var(--accent)',    // green
  error:       'var(--red)',       // red
  cancelled:   'var(--text-2)',
  paused:      'var(--text-2)',    // gray
  queued:      'var(--text-2)',
  connecting:  'var(--accent2)',
  merging:     'var(--accent2)',
  pending:     'var(--text-2)',
};

const STATUS_BADGE = {
  downloading: { bg: 'rgba(249,115,22,0.15)', color: 'var(--accent3)' },
  completed:   { bg: 'rgba(0,255,136,0.12)',  color: 'var(--accent)'  },
  error:       { bg: 'rgba(255,68,68,0.12)',  color: 'var(--red)'     },
  cancelled:   { bg: 'rgba(148,163,184,0.1)', color: 'var(--text-2)'  },
  paused:      { bg: 'rgba(148,163,184,0.1)', color: 'var(--text-2)'  },
  queued:      { bg: 'rgba(148,163,184,0.1)', color: 'var(--text-2)'  },
  connecting:  { bg: 'rgba(0,212,255,0.12)',  color: 'var(--accent2)' },
  merging:     { bg: 'rgba(0,212,255,0.12)',  color: 'var(--accent2)' },
  pending:     { bg: 'rgba(148,163,184,0.1)', color: 'var(--text-2)'  },
};

const CATEGORY_ICONS = {
  video:       '🎬',
  audio:       '🎵',
  document:    '📄',
  image:       '🖼',
  archive:     '🗜',
  application: '📦',
  other:       '📎',
};

function DownloadCard({ download, onAction }) {
  const { useState } = React;
  const [hovered, setHovered] = useState(false);

  const {
    id,
    title,
    filename,
    status = 'queued',
    progress = 0,
    downloaded = 0,
    file_size = 0,
    speed = 0,
    eta = 0,
    category = 'other',
    error_msg,
    save_path,
    chunks_total,
  } = download;

  const borderColor = STATUS_BORDER[status] || 'var(--text-2)';
  const badge       = STATUS_BADGE[status]  || STATUS_BADGE.queued;

  const isActive    = status === 'downloading';
  const isDone      = status === 'completed';
  const isPaused    = status === 'paused';
  const isError     = status === 'error';
  const isQueued    = ['queued', 'connecting', 'pending'].includes(status);

  const displayName = title || filename || 'Unknown';
  const MB = 1024 * 1024;
  const speedMbs = speed / MB;

  // Speed glow: green if >5 MB/s, yellow/orange if >1 MB/s
  function speedStyle() {
    if (speedMbs >= 5) return { color: 'var(--accent)',  textShadow: '0 0 8px rgba(0,255,136,0.5)' };
    if (speedMbs >= 1) return { color: 'var(--accent3)', textShadow: '0 0 6px rgba(249,115,22,0.4)' };
    return { color: 'var(--text-2)' };
  }

  const filePath = save_path && filename ? `${save_path}/${filename}` : (save_path || filename || '');

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'rgba(30,30,53,0.8)' : 'var(--bg-1)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${borderColor}`,
        borderRadius: 'var(--radius)',
        padding: '14px 16px',
        transition: 'background .15s',
        cursor: 'default',
      }}
    >
      {/* ROW 1: File info */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <CategoryIcon category={category} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            title={displayName}
            style={{
              fontWeight: 600, fontSize: 13, color: 'var(--text-1)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {displayName}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>
            {isDone
              ? formatBytes(file_size)
              : file_size > 0
                ? `${formatBytes(downloaded)} / ${formatBytes(file_size)}`
                : `${formatBytes(downloaded)} downloaded`
            }
          </div>
        </div>

        {/* Status badge */}
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.5px',
          padding: '3px 8px', borderRadius: 20,
          background: badge.bg, color: badge.color,
          textTransform: 'uppercase', whiteSpace: 'nowrap',
          flexShrink: 0,
        }}>
          {status}
        </span>
      </div>

      {/* ROW 2: Progress bar */}
      {!isDone && !isError && (
        <div style={{ marginBottom: isActive ? 6 : 8 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 3 }}>
            <span style={{ fontSize: 10, color: 'var(--text-2)', fontFamily: "'JetBrains Mono', monospace" }}>
              {progress > 0 ? `${Math.min(100, progress).toFixed(1)}%` : (isQueued ? 'Queued' : '0%')}
            </span>
          </div>
          <div style={{ height: 4, background: 'var(--bg-3)', borderRadius: 2, overflow: 'hidden' }}>
            <div
              className={isActive ? 'progress-active' : ''}
              style={{
                height: '100%',
                width: `${Math.min(100, Math.max(0, progress))}%`,
                background: isActive ? undefined : borderColor,
                borderRadius: 2,
                transition: isActive ? 'none' : 'width .5s',
              }}
            />
          </div>
        </div>
      )}

      {/* ROW 3: Stats (only during active download) */}
      {isActive && (
        <div style={{
          display: 'flex', gap: 12, flexWrap: 'wrap',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11, color: 'var(--text-2)',
          marginBottom: hovered ? 8 : 0,
        }}>
          <span style={speedStyle()}>↓ {formatSpeed(speed)}</span>
          <span>ETA: {formatEta(eta)}</span>
          {file_size > 0 && (
            <span>{formatBytes(downloaded)} / {formatBytes(file_size)}</span>
          )}
          {chunks_total > 0 && (
            <span>{chunks_total} threads</span>
          )}
        </div>
      )}

      {/* Error message */}
      {isError && error_msg && (
        <div style={{
          fontSize: 11, color: 'var(--red)', marginBottom: 8,
          padding: '5px 8px', background: 'rgba(255,68,68,0.08)',
          borderRadius: 5, borderLeft: '2px solid var(--red)',
        }}>
          {error_msg}
        </div>
      )}

      {/* ROW 4: Action buttons (hover only) */}
      {hovered && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {isActive && (
            <ActionBtn onClick={() => onAction?.('pause', id)} color="var(--accent3)">⏸ Pause</ActionBtn>
          )}
          {isPaused && (
            <ActionBtn onClick={() => onAction?.('resume', id)} color="var(--accent)">▶ Resume</ActionBtn>
          )}
          {(isActive || isPaused) && (
            <ActionBtn onClick={() => onAction?.('cancel', id)} color="var(--red)">✕ Cancel</ActionBtn>
          )}
          {isError && (
            <ActionBtn onClick={() => onAction?.('retry', id)} color="var(--accent2)">🔄 Retry</ActionBtn>
          )}
          {isDone && (
            <>
              <ActionBtn onClick={() => onAction?.('open', filePath)} color="var(--accent)">▶ Open File</ActionBtn>
              <ActionBtn onClick={() => onAction?.('folder', filePath)} color="var(--accent2)">📁 Open Folder</ActionBtn>
            </>
          )}
          {(isDone || isError) && (
            <ActionBtn onClick={() => onAction?.('delete', id)} color="var(--red)">🗑 Remove</ActionBtn>
          )}
        </div>
      )}
    </div>
  );
}

function CategoryIcon({ category }) {
  const icon = CATEGORY_ICONS[category] || '📎';
  return (
    <div style={{
      width: 34, height: 34, borderRadius: 8,
      background: 'var(--bg-3)', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontSize: 17, flexShrink: 0,
    }}>
      {icon}
    </div>
  );
}

function ActionBtn({ onClick, color, children }) {
  const { useState } = React;
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        padding: '3px 10px', borderRadius: 6,
        border: `1px solid ${color}30`,
        background: hov ? `${color}25` : `${color}12`,
        color, fontSize: 11, cursor: 'pointer',
        fontWeight: 500, transition: 'background .12s',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}
