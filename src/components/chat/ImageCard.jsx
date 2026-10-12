/**
 * ImageCard — Inline chat card for generated images.
 *
 * Renders a horizontal strip of thumbnails with amber NanoBanana branding.
 * Clicking a thumbnail opens the ImageLightbox.
 *
 * Props:
 *   images   - Array of { id, url, prompt, model, agent, created_at, mime_type }
 *   onOpen   - Called with (images, index) when a thumbnail is clicked
 *   baseUrl  - Optional base URL prefix for image URLs (default: '/collector')
 */

import { useNavigate } from 'react-router-dom';
import './image-card.css';

/** Map mime_type to file extension */
function extFromMime(mime) {
  if (!mime) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  return '.png';
}

export default function ImageCard({ images, onOpen, baseUrl = '/collector' }) {
  const navigate = useNavigate();
  if (!images || images.length === 0) return null;

  const modelLabel = images[0]?.model || 'Nano Banana V2';

  const handleDownload = (e, img) => {
    e.stopPropagation();
    const src = `${baseUrl}${img.url}`;
    const a = document.createElement('a');
    a.href = src;
    a.download = `${img.id || 'image'}${extFromMime(img.mime_type)}`;
    a.click();
  };

  return (
    <div className="image-card">
      {/* Header */}
      <div className="image-card__header">
        <svg className="image-card__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <span className="image-card__title">Generated Images ({images.length})</span>
        <span className="image-card__badge">{modelLabel}</span>
        <button
          className="image-card__gallery-link"
          onClick={(e) => { e.stopPropagation(); navigate('/image-gallery'); }}
          title="View in Gallery"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.7)' }} strokeWidth="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          Gallery
        </button>
      </div>

      {/* Thumbnail row */}
      <div className="image-card__thumbnails">
        {images.map((img, i) => {
          const src = `${baseUrl}${img.url}`;
          return (
            <div
              key={img.id || i}
              className="image-card__thumb-wrap"
              onClick={() => onOpen?.(images, i)}
            >
              <img
                className="image-card__thumb"
                src={src}
                alt={img.prompt || 'Generated image'}
                loading="lazy"
              />
              <div className="image-card__overlay">
                <button
                  className="image-card__overlay-btn"
                  onClick={(e) => handleDownload(e, img)}
                  title="Download"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.85)' }} strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Prompt text */}
      {images[0]?.prompt && (
        <div className="image-card__prompt">
          <span className="image-card__prompt-label">Prompt:</span>
          {images[0].prompt}
        </div>
      )}
    </div>
  );
}
