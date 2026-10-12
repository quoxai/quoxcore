/**
 * Loading/error/empty wrapper used by every view that fetches data. Keeps the
 * "never a blank page" house rule in one place.
 */
export function Skeleton({ lines = 4 }) {
  return (
    <div className="qx-stack qx-stack--compact">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="qx-skeleton qx-skeleton--line-md qxp-skeleton-line" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function ErrorCard({ error, onRetry }) {
  return (
    <div className="qx-card qx-card--compact">
      <div className="qx-stack qx-stack--tight">
        <strong>Something went wrong loading this view.</strong>
        <span className="qx-hint qx-hint--danger">{error?.message || String(error)}</span>
        {onRetry && (
          <button type="button" className="qx-btn qx-btn--sm" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

export default function AsyncBoundary({ loading, error, onRetry, skeletonLines, children }) {
  if (loading) return <Skeleton lines={skeletonLines} />;
  if (error) return <ErrorCard error={error} onRetry={onRetry} />;
  return children;
}
