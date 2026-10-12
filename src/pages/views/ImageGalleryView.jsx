/**
 * ImageGalleryView — Browse, filter, and manage generated images.
 *
 * Fetches from collector /api/v1/images with org_id scoping.
 * Supports grid/list views, prompt search, agent/model/date filtering, pagination.
 */

import { useState, useEffect, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import ImageLightbox from '../../components/chat/ImageLightbox';
import '../../components/chat/image-card.css';
import './gallery.css';

const PAGE_SIZE = 24;

/** Map mime_type to file extension */
function extFromMime(mime) {
  if (!mime) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  return '.png';
}

export default function ImageGalleryView() {
  const { currentOrg } = useOutletContext() || {};

  // Data
  const [images, setImages] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  // Dynamic filter options (populated from actual data)
  const [knownAgents, setKnownAgents] = useState([]);
  const [knownModels, setKnownModels] = useState([]);

  // Filters
  const [promptFilter, setPromptFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // UI
  const [viewMode, setViewMode] = useState('grid'); // grid | list
  const [lightbox, setLightbox] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchImages = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: PAGE_SIZE });
      if (currentOrg?.id) params.set('org_id', currentOrg.id);
      if (promptFilter) params.set('prompt', promptFilter);
      if (agentFilter) params.set('agent', agentFilter);
      if (modelFilter) params.set('model', modelFilter);
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);

      const resp = await fetch(`/collector/api/v1/images?${params}`, { credentials: 'include' });
      if (resp.ok) {
        const data = await resp.json();
        setImages(data.images || []);
        setTotal(data.total || 0);
      }
    } catch (err) {
      console.error('Failed to fetch images:', err);
    } finally {
      setLoading(false);
    }
  }, [page, currentOrg?.id, promptFilter, agentFilter, modelFilter, dateFrom, dateTo]);

  useEffect(() => { fetchImages(); }, [fetchImages]);

  // Fetch unique agents and models for filter dropdowns
  useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams({ page: 1, limit: 500 });
        if (currentOrg?.id) params.set('org_id', currentOrg.id);
        const resp = await fetch(`/collector/api/v1/images?${params}`, { credentials: 'include' });
        if (resp.ok) {
          const data = await resp.json();
          const agents = [...new Set((data.images || []).map(i => i.agent).filter(Boolean))].sort();
          const models = [...new Set((data.images || []).map(i => i.model).filter(Boolean))].sort();
          setKnownAgents(agents);
          setKnownModels(models);
        }
      } catch { /* ignore — filters just stay empty */ }
    })();
  }, [currentOrg?.id]);

  // Debounced prompt search
  const [promptInput, setPromptInput] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      setPromptFilter(promptInput);
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [promptInput]);

  const clearFilters = () => {
    setPromptInput('');
    setPromptFilter('');
    setAgentFilter('');
    setModelFilter('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  };

  const hasFilters = promptFilter || agentFilter || modelFilter || dateFrom || dateTo;

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const resp = await fetch(`/collector/api/v1/images/${deleteTarget}`, { method: 'DELETE', credentials: 'include' });
      if (resp.ok) {
        setImages(prev => prev.filter(img => img.id !== deleteTarget));
        setTotal(prev => prev - 1);
      }
    } catch (err) {
      console.error('Failed to delete image:', err);
    }
    setDeleteTarget(null);
  };

  const handleDownload = (e, img) => {
    e.stopPropagation();
    const src = `/collector${img.url}`;
    const a = document.createElement('a');
    a.href = src;
    a.download = `${img.id}${extFromMime(img.mime_type)}`;
    a.click();
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="gallery-view">
      {/* Header */}
      <div className="gallery-view__header">
        <div className="gallery-view__title-row">
          <svg className="gallery-view__icon" width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <h1 className="gallery-view__title">Image Gallery</h1>
          <span className="gallery-view__count">{total} image{total !== 1 ? 's' : ''}</span>
        </div>
        <div className="gallery-view__toggle">
          <button
            className={`gallery-view__toggle-btn ${viewMode === 'grid' ? 'gallery-view__toggle-btn--active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Grid view"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
            </svg>
          </button>
          <button
            className={`gallery-view__toggle-btn ${viewMode === 'list' ? 'gallery-view__toggle-btn--active' : ''}`}
            onClick={() => setViewMode('list')}
            title="List view"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2">
              <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
              <circle cx="4" cy="6" r="1" style={{ fill: 'rgba(255, 255, 255, 0.8)' }} /><circle cx="4" cy="12" r="1" style={{ fill: 'rgba(255, 255, 255, 0.8)' }} /><circle cx="4" cy="18" r="1" style={{ fill: 'rgba(255, 255, 255, 0.8)' }} />
            </svg>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="gallery-view__filters">
        <input
          className="gallery-view__filter-input"
          type="text"
          placeholder="Search prompts..."
          value={promptInput}
          onChange={(e) => setPromptInput(e.target.value)}
        />
        <select className="gallery-view__filter-select" value={agentFilter} onChange={(e) => { setAgentFilter(e.target.value); setPage(1); }}>
          <option value="">All Agents</option>
          {knownAgents.map(a => <option key={a} value={a}>{a.toUpperCase()}</option>)}
        </select>
        <select className="gallery-view__filter-select" value={modelFilter} onChange={(e) => { setModelFilter(e.target.value); setPage(1); }}>
          <option value="">All Models</option>
          {knownModels.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input className="gallery-view__filter-date" type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} title="From date" />
        <input className="gallery-view__filter-date" type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} title="To date" />
        {hasFilters && (
          <button className="gallery-view__filter-clear" onClick={clearFilters}>Clear</button>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="gallery-view__empty">
          <div className="gallery-view__empty-text">Loading...</div>
        </div>
      ) : images.length === 0 ? (
        <div className="gallery-view__empty">
          <svg className="gallery-view__empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <div className="gallery-view__empty-text">
            {hasFilters ? 'No images match your filters.' : 'No images yet.'}
          </div>
          <div className="gallery-view__empty-hint">
            {hasFilters ? 'Try adjusting your search or clearing filters.' : 'Ask NANOBANANA to generate one in the chat!'}
          </div>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="gallery-view__grid">
          {images.map((img, i) => {
            const src = `/collector${img.url}`;
            return (
              <div key={img.id} className="gallery-card" onClick={() => setLightbox({ images, index: i })}>
                <div className="gallery-card__image-wrap">
                  <img className="gallery-card__image" src={src} alt={img.prompt || 'Generated image'} loading="lazy" />
                  <div className="gallery-card__overlay">
                    <button className="gallery-card__action" onClick={(e) => handleDownload(e, img)} title="Download">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>
                    <button className="gallery-card__action gallery-card__action--delete" onClick={(e) => { e.stopPropagation(); setDeleteTarget(img.id); }} title="Delete">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="gallery-card__meta">
                  <div className="gallery-card__prompt">{img.prompt || 'No prompt'}</div>
                  <div className="gallery-card__tags">
                    {img.agent && <span className="gallery-card__tag">{img.agent}</span>}
                    {img.model && <span className="gallery-card__tag">{img.model.split('-').pop()}</span>}
                    {img.created_at && <span className="gallery-card__tag">{new Date(img.created_at).toLocaleDateString()}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="gallery-view__list">
          {images.map((img, i) => {
            const src = `/collector${img.url}`;
            return (
              <div key={img.id} className="gallery-list-item" onClick={() => setLightbox({ images, index: i })}>
                <img className="gallery-list-item__thumb" src={src} alt={img.prompt || 'Generated image'} loading="lazy" />
                <div className="gallery-list-item__info">
                  <div className="gallery-list-item__prompt">{img.prompt || 'No prompt'}</div>
                  <div className="gallery-list-item__detail">
                    {img.agent || '—'} &middot; {img.model ? img.model.split('-').pop() : '—'} &middot; {img.created_at ? new Date(img.created_at).toLocaleString() : '—'}
                  </div>
                </div>
                <div className="gallery-list-item__actions">
                  <button className="gallery-list-item__action-btn" onClick={(e) => handleDownload(e, img)} title="Download">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </button>
                  <button className="gallery-list-item__action-btn gallery-list-item__action-btn--delete" onClick={(e) => { e.stopPropagation(); setDeleteTarget(img.id); }} title="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="gallery-view__pagination">
          <button className="gallery-view__page-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
            &nbsp;Prev
          </button>
          <span className="gallery-view__page-info">Page {page} of {totalPages}</span>
          <button className="gallery-view__page-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
            Next&nbsp;
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2"><polyline points="9 6 15 12 9 18" /></svg>
          </button>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="gallery-confirm" onClick={() => setDeleteTarget(null)}>
          <div className="gallery-confirm__dialog" onClick={e => e.stopPropagation()}>
            <div className="gallery-confirm__title">Delete Image</div>
            <div className="gallery-confirm__text">This will permanently remove the image. This action cannot be undone.</div>
            <div className="gallery-confirm__actions">
              <button className="gallery-confirm__btn gallery-confirm__btn--cancel" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="gallery-confirm__btn gallery-confirm__btn--delete" onClick={handleDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onChange={(idx) => setLightbox(prev => ({ ...prev, index: idx }))}
        />
      )}
    </div>
  );
}
