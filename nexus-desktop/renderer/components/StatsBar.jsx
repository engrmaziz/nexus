// nexus-desktop/renderer/components/StatsBar.jsx

function StatsBar({ stats, downloads }) {
  const active = downloads.filter((d) => d.status === 'downloading').length;
  const completed = downloads.filter((d) => d.status === 'completed').length;
  const totalSpeed = downloads
    .filter((d) => d.status === 'downloading')
    .reduce((acc, d) => acc + (d.speed || 0), 0);

  const { total_bytes = 0, total_count = 0 } = stats?.totals || {};

  function formatBytes(b) {
    if (!b) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 0,
      padding: '0 16px', height: 40,
      borderBottom: '1px solid var(--border)',
      background: 'var(--surface)',
      flexShrink: 0,
      overflowX: 'auto',
    }}>
      <StatItem icon="⬇" label="Active" value={active} />
      <StatDivider />
      <StatItem icon="✔" label="Completed" value={completed} />
      <StatDivider />
      <StatItem icon="⚡" label="Speed" value={totalSpeed > 0 ? `${formatBytes(totalSpeed)}/s` : '--'} />
      <StatDivider />
      <StatItem icon="📦" label="Total downloaded" value={formatBytes(total_bytes)} />
      <StatDivider />
      <StatItem icon="📊" label="All time" value={`${total_count} files`} />
    </div>
  );
}

function StatItem({ icon, label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', whiteSpace: 'nowrap' }}>
      <span style={{ fontSize: 13 }}>{icon}</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{value}</span>
    </div>
  );
}

function StatDivider() {
  return (
    <div style={{ width: 1, height: 18, background: 'var(--border)', flexShrink: 0 }} />
  );
}
