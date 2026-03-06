// nexus-desktop/renderer/components/NotificationToast.jsx

const TOAST_COLORS = {
  success: 'var(--success)',
  error:   'var(--error)',
  warning: 'var(--warning)',
  info:    'var(--accent)',
};

const TOAST_ICONS = {
  success: '✔',
  error:   '✕',
  warning: '⚠',
  info:    'ℹ',
};

function NotificationToast({ notifications, onDismiss }) {
  if (!notifications || notifications.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed', bottom: 16, right: 16,
        display: 'flex', flexDirection: 'column', gap: 8,
        zIndex: 9999, maxWidth: 360, width: '100%',
      }}
    >
      {notifications.map((n) => (
        <Toast key={n.id} notification={n} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ notification, onDismiss }) {
  const { useState, useEffect } = React;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  const color = TOAST_COLORS[notification.type] || TOAST_COLORS.info;
  const icon  = TOAST_ICONS[notification.type]  || TOAST_ICONS.info;

  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        background: 'var(--surface)',
        border: `1px solid ${color}40`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 8, padding: '10px 12px',
        boxShadow: '0 4px 20px rgba(0,0,0,.4)',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateX(0)' : 'translateX(30px)',
        transition: 'opacity .25s, transform .25s',
      }}
    >
      <span style={{ color, fontSize: 14, marginTop: 1 }}>{icon}</span>
      <span style={{ flex: 1, fontSize: 13, color: 'var(--text)', lineHeight: 1.4 }}>
        {notification.message}
      </span>
      <button
        onClick={() => onDismiss(notification.id)}
        style={{
          background: 'none', border: 'none', color: 'var(--text-muted)',
          cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1,
        }}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
