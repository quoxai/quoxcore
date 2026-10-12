/**
 * Uploads one file to the org file_objects store (namespace 'notesq') and
 * returns its describeAttachment() result. Auth/CSRF are handled by authFetch;
 * the org comes from the workspace, mirroring other dashboard components.
 */
import { useCallback } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import fileObjects from '../../services/fileObjectsClient'
import { prepareImage } from './lib/imagePrep'
import { NAMESPACE, SOURCE_PLUGIN, validateFile, nameForPaste, attachmentUrl, describeAttachment } from './lib/attachments'

/** Gives pasted "image.png" screenshots a datestamped name. Call once per file, before the placeholder. */
export function prepareFile(raw) {
  const name = nameForPaste(raw)
  return name === raw.name ? raw : new File([raw], name, { type: raw.type })
}

export function useAttachmentUpload(noteId) {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id
  return useCallback(async (file) => {
    const name = file.name
    const bad = validateFile(file)
    if (bad) throw new Error(bad)
    // Every upload path (camera, Attach, paste, drop) comes through here: downscale/convert images first.
    const prepared = await prepareImage(file)
    const notice = prepared.notice
    file = prepared.file
    const bad2 = validateFile(file)
    if (bad2) throw new Error(bad2)
    if (!orgId) throw new Error('No organisation selected, so the file could not be attached.')
    let res
    try {
      res = await fileObjects.upload({ authFetch, orgId, namespace: NAMESPACE, file, sourcePlugin: SOURCE_PLUGIN, sourceRef: noteId })
    } catch (e) { throw new Error(`Could not attach ${name}. ${e.message}`) }
    if (!res?.id) throw new Error(`Could not attach ${name}. The server returned no file id.`)
    return { ...describeAttachment({ name: file.name, size: file.size, type: file.type, url: attachmentUrl(orgId, res.id) }), ...(notice ? { notice } : {}) }
  }, [authFetch, orgId, noteId])
}
