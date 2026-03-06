// nexus-desktop/renderer/components/Sidebar.jsx
// Navigation sidebar per spec:
//   ⬇ All Downloads  ⚡ Active  ✔ Completed  ⏸ Paused  ⳏ Queued  ✕ Failed
//   Quick actions: ＋ Add URL  ▶ Resume All  ⏸ Pause All
//   Bottom: Total saved  ⚙ Settings

const SIDEBAR_FILTERS = [
  { key: 'all',         icon: '⬇',  label: 'All Downloads' },
  { key: 'downloading', icon: '⚡',  label: 'Active'        },
  { key: 'complete',    icon: '✔',  label: 'Completed'     },
  { key: 'paused',      icon: '⏸',  label: 'Paused'        },
  { key: 'queued',      icon: 'ⳏ',  label: 'Queued'        },
  { key: 'failed',      icon: '✕',  label: 'Failed'        },
];

function Sidebar({
  downloads = [],
  activeFilter = 'all',
  stats,
  totalSpeed,
  onFilterChange,
  onAddClick,
  onResumeAll,
  onPauseAll,
  onSettingsClick,
}) {
  // Count badges per filter
  function countFor(filterKey) {
    if (filterKey === 'all') return downloads.length;
    if (filterKey === 'downloading') return downloads.filter((d) => d.status === 'downloading').length;
    if (filterKey === 'complete')    return downloads.filter((d) => d.status === 'completed').length;
    if (filterKey === 'paused')      return downloads.filter((d) => d.status === 'paused').length;
    if (filterKey === 'queued')      return downloads.filter((d) => ['queued', 'connecting', 'pending'].includes(d.status)).length;
    if (filterKey === 'failed')      return downloads.filter((d) => ['error', 'cancelled'].includes(d.status)).length;
    return 0;
  }

  const totalBytes = stats?.totals?.total_bytes || 0;

  function formatBytes(b) {
    if (!b) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  return (
    <aside
      style={{
        width: 'var(--sidebar-w)',
        background: 'var(--bg-1)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        overflowY: 'auto',
      }}
    >
      {/* Filter navigation */}
      <nav style={{ padding: '10px 6px', flex: 1 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--text-2)', padding: '6px 10px 8px' }}>
          Downloads
        </div>

        {SIDEBAR_FILTERS.map((f) => {
          const count = countFor(f.key);
          const isActive = activeFilter === f.key;
          const isActiveDownload = f.key === 'downloading' && count > 0;
          return (
            <SidebarItem
              key={f.key}
              icon={f.icon}
              label={f.label}
              count={count}
              active={isActive}
              glowGreen={isActiveDownload}
              onClick={() => onFilterChange(f.key)}
            />
          );
        })}

        {/* Quick actions */}
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--text-2)', padding: '16px 10px 8px' }}>
          Quick Actions
        </div>

        <SidebarAction icon="＋" label="Add URL" color="var(--accent)" onClick={onAddClick} />
        <SidebarAction icon="▶" label="Resume All" color="var(--accent2)" onClick={onResumeAll} />
        <SidebarAction icon="⏸" label="Pause All" color="var(--accent3)" onClick={onPauseAll} />
      </nav>

      {/* Bottom section */}
      <div
        style={{
          borderTop: '1px solid var(--border)',
          padding: '10px 8px',
        }}
      >
        <div style={{ padding: '6px 10px', marginBottom: 4 }}>
          <div style={{ fontSize: 10, color: 'var(--text-2)', marginBottom: 2 }}>Total saved</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', fontFamily: "'JetBrains Mono', monospace" }}>
            {formatBytes(totalBytes)}
          </div>
        </div>

        <SidebarAction icon="⚙" label="Settings" color="var(--text-2)" onClick={onSettingsClick} />
      </div>
    </aside>
  );
}

function SidebarItem({ icon, label, count, active, glowGreen, onClick }) {
  const { useState } = React;
  const [hovered, setHovered] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px', borderRadius: 8, border: 'none',
        background: active ? 'rgba(0,255,136,0.12)' : hovered ? 'var(--bg-3)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-1)',
        cursor: 'pointer', width: '100%', textAlign: 'left',
        fontSize: 13, fontWeight: active ? 600 : 400,
        transition: 'background .12s, color .12s',
        borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
      }}
    >
      <span
        style={{
          fontSize: 13, minWidth: 18, textAlign: 'center',
          color: glowGreen ? 'var(--accent)' : 'inherit',
          filter: glowGreen ? 'drop-shadow(0 0 4px var(--accent))' : 'none',
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {count > 0 && (
        <span style={{
          background: active ? 'rgba(0,255,136,0.2)' : 'var(--bg-3)',
          color: active ? 'var(--accent)' : 'var(--text-2)',
          fontSize: 11, padding: '1px 6px', borderRadius: 10,
          minWidth: 22, textAlign: 'center',
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 600,
        }}>
          {count}
        </span>
      )}
    </button>
  );
}

function SidebarAction({ icon, label, color, onClick }) {
  const { useState } = React;
  const [hovered, setHovered] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', borderRadius: 8, border: 'none',
        background: hovered ? 'var(--bg-3)' : 'transparent',
        color: hovered ? color : 'var(--text-2)',
        cursor: 'pointer', width: '100%', textAlign: 'left',
        fontSize: 12, fontWeight: 500,
        transition: 'background .12s, color .12s',
      }}
    >
      <span style={{ fontSize: 13, minWidth: 18, textAlign: 'center' }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
