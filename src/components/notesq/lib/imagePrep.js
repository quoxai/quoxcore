/**
 * Client-side image preparation before upload. Pure decision/size/name logic is
 * exported for tests; prepareImage() wires it to the browser (createImageBitmap,
 * canvas) and lazily loads a HEIC decoder only when the browser cannot decode.
 */

export const MAX_EDGE = 2048
export const JPEG_QUALITY = 0.85
export const SMALL_PNG_BYTES = 1.5 * 1024 * 1024
export const FALLBACK_NOTICE = 'This photo format could not be converted, it was attached as a download.'

const extOf = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : '' }
const mimeOf = (t) => String(t || '').split(';')[0].trim().toLowerCase()
const RASTER_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'])
const RASTER_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'])

/** HEIC/HEIF by mime OR extension (some browsers give an empty mime). */
export function isHeic({ name, type } = {}) {
  return /^image\/hei[cf]/.test(mimeOf(type)) || ['heic', 'heif'].includes(extOf(name))
}

/** Raster formats we may re-encode. GIF/AVIF/SVG/others are left alone. */
export function isPreparable({ name, type } = {}) {
  const m = mimeOf(type)
  if (m) return RASTER_MIMES.has(m) || isHeic({ name, type })
  return RASTER_EXTS.has(extOf(name))
}

/** Fit within maxEdge on the long side; never upscale. Integers >= 1. */
export function targetSize(width, height, maxEdge = MAX_EDGE) {
  const w = Number(width), h = Number(height)
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0, scaled: false }
  const long = Math.max(w, h)
  if (long <= maxEdge) return { width: Math.round(w), height: Math.round(h), scaled: false }
  const f = maxEdge / long
  return { width: Math.max(1, Math.round(w * f)), height: Math.max(1, Math.round(h * f)), scaled: true }
}

/**
 * Two-stage decision. Before decoding: 'skip' (GIF, non-raster) or 'decode'.
 * After decoding: 'skip' for a PNG with transparency or a small PNG, else 'reencode' (JPEG).
 */
export function decideBeforeDecode({ name, type }) {
  if (!isPreparable({ name, type })) return 'skip'
  return 'decode'
}

export function decideAfterDecode({ name, type, size, width, height, hasAlpha }) {
  const m = mimeOf(type) || (extOf(name) === 'png' ? 'image/png' : '')
  if (m === 'image/png') {
    if (hasAlpha) return 'skip'
    if (Math.max(width, height) <= MAX_EDGE && size < SMALL_PNG_BYTES) return 'skip'
  }
  return 'reencode'
}

/** Rename to .jpg when re-encoded. */
export function jpegName(name) {
  const n = String(name || 'photo')
  const base = n.replace(/\.[A-Za-z0-9]+$/, '') || 'photo'
  return `${base}.jpg`
}

async function loadHeicDecoder() {
  const mod = await import('heic2any')
  return mod.default || mod
}

async function decodeBitmap(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }) } catch {
    try { return await createImageBitmap(blob) } catch { return null }
  }
}

function hasTransparency(ctx, w, h) {
  // Sample a downscaled copy so this stays cheap on big images.
  const sw = Math.min(w, 64), sh = Math.min(h, 64)
  try {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(sw, sh) : Object.assign(document.createElement('canvas'), { width: sw, height: sh })
    const x = c.getContext('2d')
    x.drawImage(ctx, 0, 0, sw, sh)
    const d = x.getImageData(0, 0, sw, sh).data
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true
  } catch { return true } // cannot tell: be conservative, keep the PNG
  return false
}

async function encodeJpeg(bitmap, width, height) {
  let canvas
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height)
  else { canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height }
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height) // flatten any alpha onto white
  ctx.drawImage(bitmap, 0, 0, width, height)
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/jpeg', JPEG_QUALITY))
}

/**
 * Returns { file, converted, notice? }. Never throws: on any failure the original
 * is returned with a notice when it was a HEIC we could not convert.
 */
export async function prepareImage(file) {
  const info = { name: file.name, type: file.type, size: file.size }
  if (decideBeforeDecode(info) === 'skip') return { file, converted: false }
  const heic = isHeic(info)
  try {
    let bitmap = await decodeBitmap(file)
    if (!bitmap && heic) {
      const heic2any = await loadHeicDecoder()
      const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: JPEG_QUALITY })
      bitmap = await decodeBitmap(Array.isArray(out) ? out[0] : out)
    }
    if (!bitmap) throw new Error('undecodable')
    const { width, height } = bitmap
    const hasAlpha = mimeOf(file.type) === 'image/png' || extOf(file.name) === 'png' ? hasTransparency(bitmap, width, height) : false
    if (decideAfterDecode({ ...info, width, height, hasAlpha }) === 'skip') { bitmap.close?.(); return { file, converted: false } }
    const t = targetSize(width, height)
    const blob = await encodeJpeg(bitmap, t.width, t.height)
    bitmap.close?.()
    // Already a modest JPEG that did not shrink: keep the original bytes.
    if (!t.scaled && !heic && mimeOf(file.type) === 'image/jpeg' && blob.size >= file.size) return { file, converted: false }
    return { file: new File([blob], jpegName(file.name), { type: 'image/jpeg' }), converted: true }
  } catch {
    return { file, converted: false, notice: heic ? FALLBACK_NOTICE : undefined }
  }
}
