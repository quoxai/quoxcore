/**
 * usePluginLicensed — reactive licensing gate for plugin views (LL-7).
 *
 * isPluginLicensed() reads a module-scope entitlement cache in
 * licenseValidator.js. Gating views used to call it once in the render body, so
 * a POST-MOUNT entitlement refresh (a late fetch, an org switch) left them
 * stale: the page kept showing its "Activate plugin" gate on a plugin the org
 * is entitled to, until a manual reload.
 *
 * This hook reads the same synchronous check but re-runs it whenever the cache
 * is repopulated. licenseValidator.setEntitlements() dispatches a
 * `quox-entitlements-changed` window event on every write; the entitlement
 * cache is a single shared instance (the host's, shared into plugin bundles via
 * window.__quoxSharedDeps), so a bundle-rendered view's listener fires from the
 * host's write too.
 *
 * @param {string} pluginName plugin id, e.g. 'bastion-fleet'
 * @returns {boolean} whether the plugin is currently licensed
 */

import { useState, useEffect } from 'react'
import { isPluginLicensed, getPluginLicenseDiagnosis } from '../services/licenseValidator'

export function usePluginLicensed(pluginName) {
  const [licensed, setLicensed] = useState(() => isPluginLicensed(pluginName))

  useEffect(() => {
    const recheck = () => setLicensed(isPluginLicensed(pluginName))
    // Re-sync once on mount in case entitlements arrived between the initial
    // render and the effect running.
    recheck()
    if (typeof window === 'undefined') return undefined
    window.addEventListener('quox-entitlements-changed', recheck)
    return () => window.removeEventListener('quox-entitlements-changed', recheck)
  }, [pluginName])

  return licensed
}

/**
 * Same reactivity as usePluginLicensed, but returns the full diagnosis object
 * ({ licensed, code, title, detail, used, cap }) so a blocked view can explain
 * WHY it is blocked (org cap reached, no org in session, unlicensed) instead of
 * a bare "Activate" with no reason.
 * @param {string} pluginName
 */
export function usePluginLicenseDiagnosis(pluginName) {
  const [diag, setDiag] = useState(() => getPluginLicenseDiagnosis(pluginName))

  useEffect(() => {
    const recheck = () => setDiag(getPluginLicenseDiagnosis(pluginName))
    recheck()
    if (typeof window === 'undefined') return undefined
    window.addEventListener('quox-entitlements-changed', recheck)
    return () => window.removeEventListener('quox-entitlements-changed', recheck)
  }, [pluginName])

  return diag
}

export default usePluginLicensed
