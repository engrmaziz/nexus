// nexus-desktop/renderer/components/TitleBar.jsx
// Custom frameless window titlebar matching the spec:
//   Left:   ⚡ icon + "NEXUS" text
//   Center: app-region drag area (full width)
//   Right:  [_] [□] [✕] window control buttons

function TitleBar({ onAddClick }) {
  const { useState } = React;
  const [isMaximized, setIsMaximized] = useState(false);

  const minimize = () => {
    window.nexus?.window?.minimize?.();
    window.electron?.minimize?.();
  };
  const maximize = () => {
    window.nexus?.window?.maximize?.();
    window.electron?.maximize?.();
    setIsMaximized((v) => !v);
  };
  const close = () => {
    window.nexus?.window?.close?.();
    window.electron?.close?.();
  };

  return (
    <header
      style={{
        height: 40,
        background: 'var(--bg-base)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 12,
        paddingRight: 6,
        WebkitAppRegion: 'drag',
        flexShrink: 0,
        zIndex: 100,
      }}
    >
      {/* Left: ⚡ + NEXUS */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: "'Syne', sans-serif",
          fontWeight: 800,
          fontSize: 14,
          letterSpacing: '2px',
          color: 'var(--accent)',
          minWidth: 110,
          WebkitAppRegion: 'no-drag',
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1 }}>⚡</span>
        <span>NEXUS</span>
      </div>

      {/* Center: drag region */}
      <div style={{ flex: 1, WebkitAppRegion: 'drag', height: '100%' }} />

      {/* Right: Add + window controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, WebkitAppRegion: 'no-drag' }}>
        <button
          className="btn btn-primary"
          onClick={onAddClick}
          style={{
            padding: '4px 12px',
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.5px',
            background: 'var(--accent)',
            color: '#000',
            borderRadius: 8,
            gap: 4,
            marginRight: 8,
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>＋</span>
          <span>ADD</span>
        </button>

        <WinBtn onClick={minimize} title="Minimize" hoverColor="var(--accent3)">
          <span style={{ fontSize: 11, lineHeight: 1, fontWeight: 600 }}>_</span>
        </WinBtn>
        <WinBtn onClick={maximize} title={isMaximized ? 'Restore' : 'Maximize'} hoverColor="var(--accent)">
          <span style={{ fontSize: 10, lineHeight: 1 }}>{isMaximized ? '❐' : '□'}</span>
        </WinBtn>
        <WinBtn onClick={close} title="Close" hoverColor="var(--red)">
          <span style={{ fontSize: 11, lineHeight: 1, fontWeight: 600 }}>✕</span>
        </WinBtn>
      </div>
    </header>
  );
}

function WinBtn({ onClick, title, hoverColor, children }) {
  const { useState } = React;
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 26, height: 26, borderRadius: 6,
        background: hovered ? hoverColor : 'transparent',
        border: 'none',
        color: hovered ? (hoverColor === 'var(--red)' ? '#fff' : '#000') : 'var(--text-2)',
        cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background .12s, color .12s',
      }}
    >
      {children}
    </button>
  );
}
