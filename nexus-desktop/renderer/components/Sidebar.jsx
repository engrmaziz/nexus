// nexus-desktop/renderer/components/Sidebar.jsx

const CATEGORY_ICONS = {
  all:         '⬡',
  video:       '🎬',
  audio:       '🎵',
  document:    '📄',
  image:       '🖼️',
  archive:     '📦',
  application: '⚙️',
  other:       '📎',
};

const STATUS_ICONS = {
  all:         '◉',
  downloading: '⬇',
  completed:   '✔',
  paused:      '⏸',
  error:       '✕',
};

function Sidebar({ categories, statusFilters, activeCategory, activeStatus, downloads, onCategoryChange, onStatusChange }) {
  const countFor = (key, type) => {
    if (type === 'category') return key === 'all' ? downloads.length : downloads.filter((d) => d.category === key).length;
    return key === 'all' ? downloads.length : downloads.filter((d) => d.status === key).length;
  };

  return (
    <aside
      style={{
        width: 'var(--sidebar-w)',
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        padding: '12px 8px',
        gap: 4,
        flexShrink: 0,
        overflowY: 'auto',
      }}
    >
      <SectionLabel>Categories</SectionLabel>
      {categories.map((cat) => (
        <SidebarItem
          key={cat}
          icon={CATEGORY_ICONS[cat] || '•'}
          label={cat.charAt(0).toUpperCase() + cat.slice(1)}
          count={countFor(cat, 'category')}
          active={activeCategory === cat}
          onClick={() => onCategoryChange(cat)}
        />
      ))}

      <div style={{ height: 12 }} />

      <SectionLabel>Status</SectionLabel>
      {statusFilters.map((s) => (
        <SidebarItem
          key={s}
          icon={STATUS_ICONS[s] || '•'}
          label={s.charAt(0).toUpperCase() + s.slice(1)}
          count={countFor(s, 'status')}
          active={activeStatus === s}
          onClick={() => onStatusChange(s)}
        />
      ))}
    </aside>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-muted)', padding: '4px 8px 2px' }}>
      {children}
    </div>
  );
}

function SidebarItem({ icon, label, count, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px', borderRadius: 6, border: 'none',
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? '#fff' : 'var(--text)',
        cursor: 'pointer', width: '100%', textAlign: 'left',
        fontSize: 13, fontWeight: active ? 600 : 400,
        transition: 'background .15s',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface2)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ fontSize: 14, minWidth: 18, textAlign: 'center' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {count > 0 && (
        <span style={{
          background: active ? 'rgba(255,255,255,.25)' : 'var(--surface2)',
          color: active ? '#fff' : 'var(--text-muted)',
          fontSize: 11, padding: '1px 6px', borderRadius: 10, minWidth: 20, textAlign: 'center',
        }}>
          {count}
        </span>
      )}
    </button>
  );
}
