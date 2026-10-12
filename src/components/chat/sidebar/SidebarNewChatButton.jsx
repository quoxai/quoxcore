export default function SidebarNewChatButton({ onClick, title = 'New chat', className = '', style = {} }) {
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        minHeight: 24,
        padding: 0,
        marginLeft: 'auto',
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 6,
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'background 0.15s ease, border-color 0.15s ease',
        ...style,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        style={{
          fill: 'none',
          stroke: 'rgba(255,255,255,0.7)',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }}
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    </button>
  );
}
