/**
 * FileDropZone — FU-2
 *
 * Accessible drag-drop + click-to-browse zone. Fires onFiles(files: File[])
 * on valid drop/browse. Client-side mime + size checks mirror the hook's
 * so rejections happen before upload().
 */

import { useRef, useState } from 'react'

export default function FileDropZone({
  onFiles,
  accept,
  maxSize,
  multiple = true,
  label = 'Drop files here or click to browse',
  sublabel,
  disabled = false,
  style: extraStyle,
}) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  const acceptAttr = Array.isArray(accept) ? accept.join(',') : accept

  const handleFiles = (files) => {
    if (!files || files.length === 0) return
    const arr = Array.from(files)
    const filtered = maxSize ? arr.filter(f => f.size <= maxSize) : arr
    if (filtered.length === 0 && arr.length > 0) return
    onFiles?.(filtered)
  }

  const base = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 6, padding: '24px 16px', borderRadius: 10,
    border: `1.5px dashed ${dragging ? 'rgba(168,85,247,0.6)' : 'rgba(255,255,255,0.18)'}`,
    background: dragging ? 'rgba(168,85,247,0.08)' : 'rgba(255,255,255,0.02)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'border-color .15s ease, background .15s ease',
    textAlign: 'center',
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-disabled={disabled}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click() } }}
      onDragOver={e => { if (disabled) return; e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        if (disabled) return
        e.preventDefault()
        setDragging(false)
        handleFiles(e.dataTransfer?.files)
      }}
      style={{ ...base, ...extraStyle }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={acceptAttr}
        multiple={multiple}
        style={{ display: 'none' }}
        onChange={e => handleFiles(e.target.files)}
        aria-hidden="true"
      />
      <div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{label}</div>
      {sublabel && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>{sublabel}</div>}
    </div>
  )
}
