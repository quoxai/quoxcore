/**
 * useActionStats — Sidebar badge hook for Action Tracker
 *
 * Polls localStorage every 30s to provide overdue count
 * for the dynamic sidebar badge on /actions.
 */

import { useState, useEffect } from 'react'
import { getFullData, getOverdueCount, migrateItem } from '../services/actionsService'

const POLL_INTERVAL = 30_000

// ACTIONQ-FIX-SPEC 1a: this badge used to read the raw legacy
// `actions-<userId>` key directly, which (a) never carried an org_id so it
// could show a different org's cached overdue count, and (b) bypassed the
// identity/version validation the rest of the service applies. It now goes
// through getFullData(userId, orgId) — the same explicit org/user cache
// contract as the rest of actionsService.
export function useActionStats(orgId, userId) {
  const [overdueCount, setOverdueCount] = useState(0)

  useEffect(() => {
    function readOverdue() {
      try {
        const data = getFullData(userId, orgId)
        const items = (data.items || []).map(migrateItem)
        setOverdueCount(getOverdueCount(items))
      } catch {
        setOverdueCount(0)
      }
    }

    readOverdue()
    const id = setInterval(readOverdue, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [orgId, userId])

  return { overdueCount }
}
