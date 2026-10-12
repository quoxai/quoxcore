/**
 * ImageLightbox — Full-viewport image viewer shared by chat and gallery.
 *
 * Props:
 *   images    - Array of { id, url, prompt, model, agent, created_at, mime_type }
 *   index     - Currently viewed image index
 *   onClose   - Called to close the lightbox
 *   onChange  - Called with new index when navigating
 *   baseUrl   - Optional base URL prefix for image URLs (default: '/collector')
 */

import { useEffect, useCallback } from 'react';

/** Map mime_type to file extension */
function extFromMime(mime) {
  if (!mime) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  return '.png';
}

export default function ImageLightbox({ images, index, onClose, onChange, baseUrl = '/collector' }) {
  const current = images[index];
  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;

  const goPrev = useCallback(() => { if (hasPrev) onChange(index - 1); }, [hasPrev, index, onChange]);
  const goNext = useCallback(() => { if (hasNext) onChange(index + 1); }, [hasNext, index, onChange]);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, goPrev, goNext]);

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  if (!current) return null;

  const imgSrc = current.url.startsWith('/') ? `${baseUrl}${current.url}` : current.url;

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = imgSrc;
    a.download = `${current.id || 'image'}${extFromMime(current.mime_type)}`;
    a.click();
  };

  return (
    <div className="image-lightbox" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}>
        {/* Close button */}
        <button className="image-lightbox__close" onClick={onClose} aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.85)' }} strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* Navigation arrows */}
        {hasPrev && (
          <button className="image-lightbox__nav image-lightbox__nav--prev" onClick={goPrev} aria-label="Previous">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.85)' }} strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}
        {hasNext && (
          <button className="image-lightbox__nav image-lightbox__nav--next" onClick={goNext} aria-label="Next">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.85)' }} strokeWidth="2">
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </button>
        )}

        {/* Image */}
        <div className="image-lightbox__image-wrap">
          <img className="image-lightbox__image" src={imgSrc} alt={current.prompt || 'Generated image'} />
        </div>

        {/* Metadata panel */}
        <div className="image-lightbox__meta">
          <div className="image-lightbox__meta-info">
            {current.prompt && (
              <div className="image-lightbox__meta-prompt">{current.prompt}</div>
            )}
            <div className="image-lightbox__meta-tags">
              {current.model && <span className="image-lightbox__meta-tag">{current.model}</span>}
              {current.agent && <span className="image-lightbox__meta-tag">{current.agent}</span>}
              {current.created_at && (
                <span className="image-lightbox__meta-tag">
                  {new Date(current.created_at).toLocaleDateString()}
                </span>
              )}
              <span className="image-lightbox__meta-tag">
                {index + 1} / {images.length}
              </span>
            </div>
          </div>
          <button className="image-lightbox__download" onClick={handleDownload}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.85)' }} strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </button>
        </div>
      </div>
    </div>
  );
}
