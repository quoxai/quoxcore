/**
 * GlassAttachmentChip — QCX-5d
 *
 * File chip shared by composer uploads (visitor side) and bot-returned
 * files (message side). Image mimes get a thumbnail from a safe URL
 * (http/https/// or data:image/*); non-images get a paperclip icon.
 * Optional remove button, optional download anchor.
 */

import { isSafeUrl } from './_urlGuard';
import './glass-chat.css';

function isSafePreviewUrl(url) {
  return typeof url === 'string' && (isSafeUrl(url) || /^data:image\//i.test(url));
}

export function GlassAttachmentChip({
  name,
  mime = '',
  previewUrl,
  downloadUrl,
  uploading = false,
  onRemove,
}) {
  const isImage = typeof mime === 'string' && mime.startsWith('image/');
  const showThumb = isImage && isSafePreviewUrl(previewUrl);

  const inner = (
    <>
      {showThumb ? (
        <span className="gac__thumb" style={{ backgroundImage: `url(${previewUrl})` }} />
      ) : (
        <span className="gac__icon" aria-hidden="true">📎</span>
      )}
      <span className="gac__name" title={name}>{name}</span>
      {uploading && <span className="gac__spinner" aria-label="Uploading" />}
    </>
  );

  const chipAttrs = uploading ? { 'data-uploading': 'true' } : {};

  if (isSafeUrl(downloadUrl) && !onRemove) {
    return (
      <a className="gac" href={downloadUrl} target="_blank" rel="noopener noreferrer" {...chipAttrs}>
        {inner}
      </a>
    );
  }

  return (
    <span className="gac" {...chipAttrs}>
      {inner}
      {typeof onRemove === 'function' && (
        <button
          type="button"
          className="gac__x"
          aria-label="Remove attachment"
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </span>
  );
}
