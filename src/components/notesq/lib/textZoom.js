/** NotesQ's text size, on the shared per-device helper (src/lib/textZoom.js). */
import { loadZoom as load, saveZoom as save } from '../../../lib/textZoom'

export { ZOOM_STEPS, DEFAULT_ZOOM, clampZoom, stepZoom } from '../../../lib/textZoom'
const KEY = 'quox.notesq.textZoom'
export const loadZoom = () => load(KEY)
export const saveZoom = (z) => save(KEY, z)
