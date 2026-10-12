/**
 * useFileService — FU-5
 *
 * Feature-detects the FU-1 file service. Plugins call this at mount and
 * render conditional UI based on `available`:
 *
 *   const { loading, available, uploadEndpoint, maxSize } = useFileService({ authFetch, orgId })
 *   if (loading) return null
 *   if (!available) return <LegacyUploader/>
 *   return <QuoxChatFileUploader endpoint={uploadEndpoint} />
 *
 * The detection probes `GET /api/orgs/:orgId/files?limit=0` — cheap + idempotent.
 */

import { useState, useEffect } from 'react'

const DEFAULT_MAX_SIZE = 25 * 1024 * 1024

export default function useFileService({ authFetch, orgId } = {}) {
  const [state, setState] = useState({ loading: true, available: null })

  useEffect(() => {
    if (!authFetch || !orgId) {
      setState({ loading: false, available: false })
      return
    }
    let cancelled = false
    authFetch(`/api/orgs/${orgId}/files?limit=0`)
      .then(r => {
        if (cancelled) return
        setState({ loading: false, available: r.ok })
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, available: false })
      })
    return () => { cancelled = true }
  }, [authFetch, orgId])

  return {
    loading: state.loading,
    available: state.available,
    listEndpoint: orgId ? `/api/orgs/${orgId}/files` : null,
    uploadEndpoint: orgId ? `/api/orgs/${orgId}/files/upload` : null,
    maxSize: DEFAULT_MAX_SIZE,
  }
}
