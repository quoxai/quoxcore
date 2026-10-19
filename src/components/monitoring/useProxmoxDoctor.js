/**
 * useProxmoxDoctor: run VM Doctor (GET /api/v1/proxmox/doctor/:target) for one VM through the
 * authenticated collector fetch. The server is the source of truth (it also stores the report
 * org-scoped); nothing is persisted client-side. Read only.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { poolErrorText } from './useProxmoxPool'

export const DOCTOR_URL = '/collector/api/v1/proxmox/doctor'

export function useProxmoxDoctor(vm) {
  const { authFetch } = useAuth()
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(!!vm)
  const seq = useRef(0)
  const vmid = vm && vm.vmid

  const run = useCallback(async () => {
    if (vmid === undefined || vmid === null) return null
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const res = await authFetch(`${DOCTOR_URL}/${encodeURIComponent(vmid)}`)
      let body = null
      try { body = await res.json() } catch { body = null }
      if (mine !== seq.current) return null
      if (!res.ok || !body || !body.report) {
        setReport(null)
        setError(body && (body.detail || body.message || body.error) ? String(body.detail || body.message || body.error) : poolErrorText(body, res.status))
        setLoading(false)
        return null
      }
      setReport(body.report)
      setLoading(false)
      return body.report
    } catch (e) {
      if (mine === seq.current) { setReport(null); setError(e && e.message ? e.message : 'Could not reach the collector'); setLoading(false) }
      return null
    }
  }, [authFetch, vmid])

  useEffect(() => {
    setReport(null)
    run()
    return () => { seq.current += 1 }
  }, [run])

  return { report, error, loading, rerun: run }
}

/** A finding's gated fix -> an action for the existing action flow (HYPERION chat + approval). */
export function fixToAction(finding, vm) {
  const a = finding && finding.fix && finding.fix.action
  if (!a || !a.tool) return null
  return {
    id: `doctor-fix-${finding.id}`,
    icon: '▶',
    label: finding.fix.text,
    description: `${a.tool} ${JSON.stringify(a.input || {})}`,
    prompt: `VM Doctor found "${finding.title}" on ${vm && (vm.name || vm.vmid)}. Run ${a.tool} with ${JSON.stringify(a.input || {})}. This is a gated action: it will ask for approval first.`,
  }
}
