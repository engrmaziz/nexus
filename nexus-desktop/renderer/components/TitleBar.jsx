// nexus-desktop/renderer/components/TitleBar.jsx

function TitleBar({ onAddClick }) {
  const { useState } = React;
  const [isMaximized, setIsMaximized] = useState(false);

  const minimize = () => window.nexus?.window?.minimize?.();
  const maximize = () => {
    window.nexus?.window?.maximize?.();
    setIsMaximized((v) => !v);
  };
  const close = () => window.nexus?.window?.close?.();

  return (
    <header
      style={{
        height: 48,
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 16,
        paddingRight: 8,
        WebkitAppRegion: 'drag',
        flexShrink: 0,
      }}
    >
      {/* Logo */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontWeight: 700,
          fontSize: 16,
          letterSpacing: '.5px',
          color: 'var(--accent)',
          minWidth: 120,
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
          <path d="M8 12l4 4 4-4M12 8v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        Nexus
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Add Download button */}
      <button
        className="btn btn-primary"
        onClick={onAddClick}
        style={{ WebkitAppRegion: 'no-drag', marginRight: 8 }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
        New Download
      </button>

      {/* Window controls */}
      <div
        style={{ display: 'flex', gap: 4, WebkitAppRegion: 'no-drag' }}
      >
        <WinButton onClick={minimize} title="Minimize" color="#facc15">
          <span style={{ fontSize: 10, lineHeight: 1 }}>—</span>
        </WinButton>
        <WinButton onClick={maximize} title={isMaximized ? 'Restore' : 'Maximize'} color="#4ade80">
          <span style={{ fontSize: 9, lineHeight: 1 }}>{isMaximized ? '❐' : '□'}</span>
        </WinButton>
        <WinButton onClick={close} title="Close" color="#f87171">
          <span style={{ fontSize: 10, lineHeight: 1 }}>✕</span>
        </WinButton>
      </div>
    </header>
  );
}

function WinButton({ onClick, title, color, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 28, height: 28, borderRadius: 6,
        background: 'var(--surface2)',
        border: '1px solid var(--border)',
        color: 'var(--text-muted)', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background .15s, color .15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = color; e.currentTarget.style.color = '#000'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface2)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
    >
      {children}
    </button>
  );
}
