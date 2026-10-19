/**
 * alertmanagerConfig.js (quox#1061)
 *
 * The Alertmanager base URL used to be env-only (process.env.ALERTMANAGER_URL),
 * read separately by toolExecutors/monitoring.js and bastionSshExecutor.js.
 * House rule: no env-only config. It is now the platform setting
 * ALERTMANAGER_URL (lib/platformCapabilities.js, group 'integrations'),
 * resolved per call through configResolver, the same store
 * `quox settings set ALERTMANAGER_URL <url>` writes to.
 *
 * Precedence:
 *   1. the caller org's stored setting           source 'setting'
 *   2. the instance-scope stored setting          source 'instance_setting'
 *   3. env ALERTMANAGER_URL (fallback)            source 'env'
 *   4. legacy monitoring-config.json alertmanager.url   source 'monitoring_config'
 *   5. nothing                                    source 'unset' + honest error
 *
 * Every value is checked as an http(s) URL; a malformed env or legacy value is
 * reported, never used. Never throws. Fetchers must use resolveAlertmanagerTarget
 * (async), which also runs an ORG value through lib/monitoringEgressPolicy.js.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { isHttpUrl } = require('./platformCapabilities.js');

const ALERTMANAGER_SETTING_KEY = 'ALERTMANAGER_URL';
const ALERTMANAGER_NOT_CONFIGURED =
  'Alertmanager is not configured: set it with quox settings set ALERTMANAGER_URL <url>';

function monitoringConfigPath() {
  return path.join(
    process.env.AEE_DB_PATH ? path.dirname(process.env.AEE_DB_PATH) : '/var/lib/quox',
    'monitoring-config.json'
  );
}

function readLegacyMonitoringConfigUrl() {
  try {
    const config = JSON.parse(fs.readFileSync(monitoringConfigPath(), 'utf8'));
    return (config && config.alertmanager && typeof config.alertmanager.url === 'string') ? config.alertmanager.url : '';
  } catch {
    return '';
  }
}

function clean(url) {
  return String(url).trim().replace(/\/+$/, '');
}

function invalid(source) {
  return {
    url: '',
    source,
    error: `Alertmanager URL from ${source} is not a valid http(s) URL: set a valid one with quox settings set ALERTMANAGER_URL <url>`,
  };
}

/**
 * @param {string|null|undefined} orgId - caller org (ctx.orgId); null skips the org layer
 * @param {{ configResolver?: object, readLegacyUrl?: () => string, env?: object }} [deps]
 * @returns {{ url: string, source: string, error?: string }}
 */
function resolveAlertmanagerUrl(orgId, deps = {}) {
  const resolver = deps.configResolver || require('./configResolver.js');
  const env = deps.env || process.env;
  const readLegacyUrl = deps.readLegacyUrl || readLegacyMonitoringConfigUrl;

  try {
    if (orgId) {
      const r = resolver.getSetting(orgId, ALERTMANAGER_SETTING_KEY);
      if (r && r.source === 'setting' && r.value && isHttpUrl(r.value)) {
        return { url: clean(r.value), source: 'setting' };
      }
    }
    const inst = resolver.getInstanceSetting(ALERTMANAGER_SETTING_KEY);
    if (inst && inst.source === 'setting' && inst.value && isHttpUrl(inst.value)) {
      return { url: clean(inst.value), source: 'instance_setting' };
    }
  } catch {
    // settings store unreachable: fall through to env, never throw
  }

  const envValue = (env.ALERTMANAGER_URL || '').trim();
  if (envValue) {
    return isHttpUrl(envValue) ? { url: clean(envValue), source: 'env' } : invalid('env');
  }

  const legacy = (readLegacyUrl() || '').trim();
  if (legacy) {
    return isHttpUrl(legacy) ? { url: clean(legacy), source: 'monitoring_config' } : invalid('monitoring_config');
  }

  return { url: '', source: 'unset', error: ALERTMANAGER_NOT_CONFIGURED };
}

/**
 * Use-time resolution for the fetchers. Same precedence as
 * resolveAlertmanagerUrl; an ORG-sourced value additionally passes the
 * monitoring egress policy (DNS resolved, every address checked). A refused
 * org value is reported, never silently replaced by env.
 *
 * @param {string|null|undefined} orgId
 * @param {{ resolver?: object }} [deps] - plus resolveAlertmanagerUrl deps
 * @returns {Promise<{ url: string, source: string, error?: string }>}
 */
async function resolveAlertmanagerTarget(orgId, deps = {}) {
  const r = resolveAlertmanagerUrl(orgId, deps);
  if (r.source !== 'setting' || !r.url) return r;
  try {
    await require('./monitoringEgressPolicy.js').assertOrgMonitoringUrlSafe(r.url, { resolver: deps.resolver });
    return r;
  } catch (err) {
    return {
      url: '',
      source: 'setting',
      refused: true,
      error: `Alertmanager URL set for this org is refused: ${err.message}. Set a reachable monitoring address with quox settings set ALERTMANAGER_URL <url>`,
    };
  }
}

module.exports = {
  resolveAlertmanagerTarget,
  ALERTMANAGER_SETTING_KEY,
  ALERTMANAGER_NOT_CONFIGURED,
  resolveAlertmanagerUrl,
  readLegacyMonitoringConfigUrl,
};
