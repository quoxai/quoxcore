/**
 * FileUploadToast — FU-2
 *
 * Renders a single upload status row. Shape matches the entry shape from
 * useFileUpload: { id, filename, size, progress, status, error, result }.
 * Stateless — callbacks (onRetry, onCancel) let the caller wire into the
 * hook's retry/cancel.
 */

function formatBytes(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

const ICONS = { queued: '•', uploading: '↑', done: '✓', error: '✗' }

// qx-toast has no dedicated --info variant; the base (unmodified) class is
// the cyan/info treatment, so queued/uploading intentionally get no modifier.
const VARIANTS = { done: 'qx-toast--success', error: 'qx-toast--error' }

export default function FileUploadToast({ upload, onRetry, onCancel }) {
  if (!upload) return null
  const icon = ICONS[upload.status] || ICONS.queued
  const variant = VARIANTS[upload.status] || ''
  return (
    <div
      data-testid={`upload-toast-${upload.id}`}
      className={`qx-toast${variant ? ` ${variant}` : ''}`}
      style={{ padding: '8px 10px', minWidth: 0, fontSize: 11 }}
    >
      <span aria-hidden="true" className="qx-toast__icon" style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</span>
      <div className="qx-toast__body" style={{ minWidth: 0 }}>
        <div className="qx-toast__title" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{upload.filename}</div>
        <div className="qx-toast__msg">
          {upload.status === 'error'
            ? (upload.error || 'Upload failed')
            : upload.status === 'done'
              ? `Uploaded · ${formatBytes(upload.size)}`
              : upload.status === 'uploading'
                ? `Uploading${typeof upload.progress === 'number' ? ' ' + Math.round(upload.progress * 100) + '%' : '…'}`
                : 'Queued'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {upload.status === 'error' && onRetry && (
          <button type="button" onClick={() => onRetry(upload.id)} style={{ padding: '3px 8px', fontSize: 10, fontWeight: 700, background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: 4, color: '#a855f7', cursor: 'pointer' }}>
            Retry
          </button>
        )}
        {onCancel && upload.status !== 'uploading' && (
          <button type="button" className="qx-toast__close" aria-label="Remove upload" onClick={() => onCancel(upload.id)}>
            ×
          </button>
        )}
      </div>
    </div>
  )
}
