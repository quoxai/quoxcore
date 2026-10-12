/**
 * useUpdateStatus — Polling hook for system update status.
 * Fetches update-status endpoint every 30 minutes.
 *
 * Returns: { status, loading, error, refetch, checkNow }
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useWorkspace } from '../contexts/WorkspaceContext'
import { createUpdateService } from '../services/maintenance/updateService'

const POLL_INTERVAL = 30 * 60 * 1000 // 30 minutes

export function useUpdateStatus() {
    const { authFetch, isDevMode } = useAuth()
    const { currentOrg } = useWorkspace()
    const [status, setStatus] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [checking, setChecking] = useState(false)
    const intervalRef = useRef(null)

    const svc = useMemo(() => {
        if (!currentOrg?.id) return null
        try {
            return createUpdateService(authFetch, currentOrg.id)
        } catch {
            return null
        }
    }, [authFetch, currentOrg?.id])

    const refetch = useCallback(async () => {
        if (isDevMode) {
            setStatus(null)
            setError(null)
            setLoading(false)
            return
        }
        if (!svc) {
            setLoading(false)
            return
        }
        try {
            const data = await svc.getUpdateStatus()
            setStatus(data)
            setError(null)
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }, [isDevMode, svc])

    const checkNow = useCallback(async () => {
        if (isDevMode) return null
        if (!svc) return null
        setChecking(true)
        try {
            const data = await svc.checkForUpdates()
            // Update local status with check result
            setStatus(prev => ({
                ...prev,
                current_version: data.current_version,
                available_version: data.available_version,
                update_available: data.update_available,
                release_notes_md: data.release_notes_md,
                published_at: data.published_at,
                release_url: data.release_url,
                last_check: data.checked_at
            }))
            setError(null)
            return data
        } catch (err) {
            setError(err.message)
            return null
        } finally {
            setChecking(false)
        }
    }, [isDevMode, svc])

    useEffect(() => {
        refetch()
        intervalRef.current = setInterval(refetch, POLL_INTERVAL)
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current)
        }
    }, [refetch])

    return { status, loading, error, checking, refetch, checkNow }
}

export default useUpdateStatus
