// nexus-desktop/renderer/components/DownloadList.jsx

function DownloadList({ downloads, searchQuery, onSearchChange, onAction }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Search bar */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ position: 'relative' }}>
          <span style={{
            position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--text-muted)', fontSize: 13, pointerEvents: 'none',
          }}>
            🔍
          </span>
          <input
            className="input"
            type="text"
            placeholder="Search downloads…"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            style={{ paddingLeft: 32 }}
          />
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {downloads.length === 0 ? (
          <EmptyState hasSearch={!!searchQuery} />
        ) : (
          downloads.map((dl) => (
            <DownloadCard key={dl.id} download={dl} onAction={onAction} />
          ))
        )}
      </div>
    </div>
  );
}

function EmptyState({ hasSearch }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-muted)', gap: 12, paddingTop: 80,
    }}>
      <div style={{ fontSize: 48 }}>{hasSearch ? '🔍' : '⬇'}</div>
      <div style={{ fontSize: 15, fontWeight: 500 }}>
        {hasSearch ? 'No matching downloads' : 'No downloads yet'}
      </div>
      <div style={{ fontSize: 13 }}>
        {hasSearch ? 'Try a different search term' : 'Click "New Download" to get started'}
      </div>
    </div>
  );
}
