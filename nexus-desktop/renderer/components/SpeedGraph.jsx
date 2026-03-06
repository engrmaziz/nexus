// nexus-desktop/renderer/components/SpeedGraph.jsx
// Renders a live line graph of download speed over time using Recharts.

const { useState, useEffect, useRef } = React;

const MAX_POINTS = 60; // 60 seconds of history

function SpeedGraph({ downloadId }) {
  const [data, setData] = useState([]);
  const intervalRef = useRef(null);

  useEffect(() => {
    // Poll the download once per second to get the current speed
    intervalRef.current = setInterval(async () => {
      if (!window.nexus?.download?.getOne) return;
      try {
        const dl = await window.nexus.download.getOne(downloadId);
        if (!dl) return;

        const point = {
          time: new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          speed: Math.round((dl.speed || 0) / 1024), // KB/s
        };

        setData((prev) => {
          const next = [...prev, point];
          return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
        });
      } catch (_) {}
    }, 1000);

    return () => clearInterval(intervalRef.current);
  }, [downloadId]);

  // Use Recharts from global scope (loaded via CDN)
  const { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } = window.Recharts || {};

  if (!LineChart) return null;

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Speed (KB/s)</div>
      <ResponsiveContainer width="100%" height={80}>
        <LineChart data={data} margin={{ top: 2, right: 8, left: 0, bottom: 2 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="time" hide />
          <YAxis width={35} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
          <Tooltip
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 11 }}
            labelStyle={{ color: 'var(--text-muted)' }}
            formatter={(v) => [`${v} KB/s`, 'Speed']}
          />
          <Line
            type="monotone"
            dataKey="speed"
            stroke="var(--accent)"
            dot={false}
            strokeWidth={2}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
