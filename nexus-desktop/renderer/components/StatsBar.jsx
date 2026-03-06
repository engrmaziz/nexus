// nexus-desktop/renderer/components/StatsBar.jsx

function StatsBar({ stats, downloads, totalSpeed = 0 }) {
  const active    = downloads.filter((d) => d.status === 'downloading').length;
  const completed = downloads.filter((d) => d.status === 'completed').length;
  const speed     = totalSpeed || downloads
    .filter((d) => d.status === 'downloading')
    .reduce((acc, d) => acc + (d.speed || 0), 0);

  const { total_bytes = 0, total_count = 0 } = stats?.totals || {};

  function formatBytes(b) {
    if (!b || b <= 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '0 16px', height: 36,
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg-2)',
      flexShrink: 0,
      overflowX: 'auto',
      gap: 0,
    }}>
      <StatItem icon="⬇" label="Active"    value={active}  accent={active > 0 ? 'var(--accent)' : undefined} />
      <StatDivider />
      <StatItem icon="✔" label="Completed" value={completed} />
      <StatDivider />
      <StatItem
        icon="⚡"
        label="Speed"
        value={speed > 0 ? `${formatBytes(speed)}/s` : '--'}
        accent={speed > 0 ? 'var(--accent)' : undefined}
        mono
      />
      <StatDivider />
      <StatItem icon="📦" label="Total saved"  value={formatBytes(total_bytes)} mono />
      <StatDivider />
      <StatItem icon="📊" label="All time" value={`${total_count} files`} />
    </div>
  );
}

function StatItem({ icon, label, value, accent, mono }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 12px', whiteSpace: 'nowrap' }}>
      <span style={{ fontSize: 12 }}>{icon}</span>
      <span style={{ fontSize: 10, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</span>
      <span style={{
        fontSize: 11, fontWeight: 700,
        color: accent || 'var(--text-1)',
        fontFamily: mono ? "'JetBrains Mono', monospace" : 'inherit',
      }}>
        {value}
      </span>
    </div>
  );
}

function StatDivider() {
  return (
    <div style={{ width: 1, height: 16, background: 'var(--border)', flexShrink: 0 }} />
  );
}
