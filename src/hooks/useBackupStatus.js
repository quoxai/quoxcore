/**
 * useBackupStatus — Polling hook for backup health status.
 * Fetches backup-status endpoint every 5 minutes.
 *
 * Returns: { status, loading, error, refetch }
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useWorkspace } from '../contexts/WorkspaceContext'
import { createBackupService } from '../services/backup/backupService'

const POLL_INTERVAL = 5 * 60 * 1000 // 5 minutes

export function useBackupStatus() {
    const { authFetch, isDevMode } = useAuth()
    const { currentOrg } = useWorkspace()
    const [status, setStatus] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const intervalRef = useRef(null)

    const svc = useMemo(() => {
        if (!currentOrg?.id) return null
        try {
            return createBackupService(authFetch, currentOrg.id)
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
            const data = await svc.getBackupStatus()
            setStatus(data)
            setError(null)
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }, [isDevMode, svc])

    useEffect(() => {
        refetch()
        intervalRef.current = setInterval(refetch, POLL_INTERVAL)
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current)
        }
    }, [refetch])

    return { status, loading, error, refetch }
}

export default useBackupStatus
