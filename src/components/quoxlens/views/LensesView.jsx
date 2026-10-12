import { useCallback } from 'react';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import AsyncBoundary from '../components/AsyncBoundary.jsx';
import LensCard from '../components/LensCard.jsx';

const fetchLenses = () => api.listLenses();

/**
 * Every Lens QuoxLens can currently apply, one card each. This is the
 * surface the whole task exists for: the honesty-and-claims Lens currently
 * loses to baseline on its own eval, and this view says so plainly rather
 * than flattering it.
 */
export default function LensesView() {
  const { loading, error, data, retry } = useAsync(useCallback(fetchLenses, []), []);
  const lenses = data?.lenses || [];

  return (
    <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={6}>
      {lenses.length === 0 ? (
        <div className="qx-empty">
          <div className="qx-empty__title">No Lenses found</div>
          <div className="qx-empty__body">Nothing under src/config/lenses/ yet.</div>
        </div>
      ) : (
        <div className="qx-grid-2">
          {lenses.map((lens) => (
            <LensCard key={lens.id} lens={lens} />
          ))}
        </div>
      )}
    </AsyncBoundary>
  );
}
