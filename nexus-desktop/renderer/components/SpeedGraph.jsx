// nexus-desktop/renderer/components/SpeedGraph.jsx
// Real-time download speed chart using Canvas API.
// Keeps last 60 seconds of total speed samples.
// Updates every 1 second; renders at 60fps via requestAnimationFrame.

function SpeedGraph({ downloads = [], totalSpeed = 0 }) {
  const { useRef, useEffect, useState } = React;

  const canvasRef    = useRef(null);
  const samplesRef   = useRef([]);   // up to 60 seconds of samples (bytes/s)
  const rafRef       = useRef(null);
  const intervalRef  = useRef(null);
  const peakRef      = useRef(0);

  const MB = 1024 * 1024;

  function fmtSpeed(b) {
    if (!b || b <= 0) return '0 B/s';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}/s`;
  }

  // Collect a sample every second
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      const spd = downloads
        .filter((d) => d.status === 'downloading')
        .reduce((acc, d) => acc + (d.speed || 0), 0);

      if (spd > peakRef.current) peakRef.current = spd;

      samplesRef.current = [...samplesRef.current, spd].slice(-60);
    }, 1000);

    return () => clearInterval(intervalRef.current);
  }, [downloads]);

  // Draw on canvas at 60fps
  useEffect(() => {
    function draw() {
      const canvas = canvasRef.current;
      if (!canvas) { rafRef.current = requestAnimationFrame(draw); return; }

      const ctx    = canvas.getContext('2d');
      const w      = canvas.width;
      const h      = canvas.height;
      const samples = samplesRef.current;
      const peak   = peakRef.current;
      const currentSpd = totalSpeed;

      ctx.clearRect(0, 0, w, h);

      // Background
      ctx.fillStyle = 'var(--bg-1)';
      ctx.fillRect(0, 0, w, h);

      const maxVal = Math.max(peak, 1);

      // Grid lines (4 horizontal)
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth   = 1;
      for (let i = 1; i <= 4; i++) {
        const y = Math.round((h * i) / 4) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      if (samples.length >= 2) {
        const step = w / 59; // 60 points → 59 gaps

        // Build points array (pad with zeros if needed)
        const pts = [];
        for (let i = 0; i < 60; i++) {
          const val = samples[i] || 0;
          const x   = i * step;
          const y   = h - (val / maxVal) * (h - 8);
          pts.push([x, y]);
        }

        // Area fill (gradient)
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0,   'rgba(0,255,136,0.30)');
        grad.addColorStop(1,   'rgba(0,255,136,0)');

        ctx.beginPath();
        ctx.moveTo(pts[0][0], h);
        ctx.lineTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i][0], pts[i][1]);
        }
        ctx.lineTo(pts[pts.length - 1][0], h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Stroke line
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i][0], pts[i][1]);
        }
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth   = 2;
        ctx.lineJoin    = 'round';
        ctx.stroke();
      }

      // Current speed (large, top-left)
      ctx.font      = 'bold 13px "JetBrains Mono", monospace';
      ctx.fillStyle = '#00ff88';
      ctx.shadowColor  = 'rgba(0,255,136,0.5)';
      ctx.shadowBlur   = 6;
      ctx.fillText(`↓ ${fmtSpeed(currentSpd)}`, 10, 18);
      ctx.shadowBlur   = 0;

      // Peak (smaller, next to current)
      if (peak > 0) {
        ctx.font      = '11px "JetBrains Mono", monospace';
        ctx.fillStyle = 'rgba(148,163,184,0.7)';
        ctx.fillText(`Peak: ${fmtSpeed(peak)}`, 10, h - 6);
      }

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [totalSpeed]);

  // Resize canvas to match its CSS size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    });
    ro.observe(canvas);
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    return () => ro.disconnect();
  }, []);

  const activeCount = downloads.filter((d) => d.status === 'downloading').length;

  return (
    <div style={{ background: 'var(--bg-1)', borderTop: '1px solid var(--border)', padding: '0 0 2px' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: 80 }}
      />
      <div style={{
        padding: '4px 12px 6px',
        fontSize: 11,
        fontFamily: "'JetBrains Mono', monospace",
        color: 'var(--text-2)',
        display: 'flex', gap: 8, alignItems: 'center',
      }}>
        <span style={{ color: totalSpeed > 0 ? 'var(--accent)' : 'var(--text-2)' }}>
          ↓ {fmtSpeed(totalSpeed)} total
        </span>
        <span>•</span>
        <span>{activeCount} active</span>
        {peakRef.current > 0 && (
          <>
            <span>•</span>
            <span>Peaked at {fmtSpeed(peakRef.current)}</span>
          </>
        )}
      </div>
    </div>
  );
}
