/**
 * WARD Hooks — CommonJS bridge for collector integration.
 *
 * The WARD service is ESM. This module provides lazy-loaded CJS-compatible
 * wrappers that the collector (CJS) can require().
 *
 * All functions are fire-and-forget — errors are logged, never thrown.
 */

let _hooks = null;
let _loading = false;
let _loadError = null;

// QUOXTRUST T1/D1 (FND_..SB5J) — a WARD witness call that cannot run because the hooks
// are not initialised must NEVER be a SILENT no-op: the witness (tamper-evidence) layer
// vanishing untraced is exactly the evidence hole the standard forbids. Account every
// dropped witness call per type and rate-limit a warn, so a boot-window gap is visible
// and (via wardHooksStatus, surfaced on /health) a PERMANENT init failure alarms instead
// of the /security projection silently showing gaps. This does not block the caller
// (witnessing stays fire-and-forget); it makes the drop observable.
const _dropped = { aee: 0, aocl: 0, volt: 0 };
let _lastDropWarn = 0;
function _accountDroppedWitness(kind) {
  _dropped[kind] = (_dropped[kind] || 0) + 1;
  const total = _dropped.aee + _dropped.aocl + _dropped.volt;
  // Throttle: one warn per ~5s so a boot-window burst does not flood logs.
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : (_lastDropWarn + 5001);
  if (now - _lastDropWarn > 5000) {
    _lastDropWarn = now;
    const why = _loadError ? `load failed: ${_loadError.message}` : (_initPromise ? 'not initialised yet (boot window)' : 'never initialised');
    console.warn(`[WARD] witness DROPPED (${kind}) — hooks unavailable (${why}); ${total} witness call(s) unrecorded so far. Evidence receipt missing for this event.`);
  }
}

async function loadHooks() {
  if (_hooks) return _hooks;
  if (_loadError) return null;
  if (_loading) return null;

  _loading = true;
  try {
    _hooks = await import('./lib/hooks.js');
    _loading = false;
    return _hooks;
  } catch (err) {
    _loadError = err;
    _loading = false;
    console.error('[WARD] Failed to load hooks module:', err.message);
    return null;
  }
}

let _initPromise = null;

/**
 * Initialise WARD hooks. Call once at collector startup.
 * @param {object} opts - { dbPath, chainId, issuerId, tipInterval, keyPubPath, keyPrivPath, metaChainId }
 */
async function initWardHooks(opts) {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const hooks = await loadHooks();
    if (hooks) hooks.initWardHooks(opts);
  })();
  return _initPromise;
}

/**
 * Witness an AEE envelope. Fire-and-forget.
 */
function wardHookAEE(envelope) {
  if (!_hooks) { _accountDroppedWitness('aee'); return; }
  try {
    _hooks.wardHookAEE(envelope);
  } catch (err) {
    console.warn('[WARD] AEE hook error:', err.message);
  }
}

/**
 * Run a burst of witness calls in one ward.db transaction (see lib/hooks.js wardBatch).
 * Without hooks loaded it just runs fn, so the per-call accounting above still applies.
 */
function wardBatch(fn) {
  if (!_hooks || typeof _hooks.wardBatch !== 'function') return fn();
  return _hooks.wardBatch(fn);
}

/**
 * Witness an AOCL layer event. Fire-and-forget.
 */
function wardHookAOCL(envelope) {
  if (!_hooks) { _accountDroppedWitness('aocl'); return; }
  try {
    _hooks.wardHookAOCL(envelope);
  } catch (err) {
    console.warn('[WARD] AOCL hook error:', err.message);
  }
}

/**
 * Witness a VOLT event or bundle. Fire-and-forget.
 */
function wardHookVOLT(event) {
  if (!_hooks) { _accountDroppedWitness('volt'); return; }
  try {
    _hooks.wardHookVOLT(event);
  } catch (err) {
    console.warn('[WARD] VOLT hook error:', err.message);
  }
}

/**
 * LICENSE-LAUNCH LL-9i4: countersign a finalized VOLT bundle via the Quox
 * Verified control plane. Lazy-loads the ESM sink module and resolves the
 * client config from env (the same config the WARD sink uses). Fail-soft:
 * every failure returns { success:false } without throwing, so the bundle
 * finalization never depends on the countersignature.
 *
 * @param {object} bundleManifest
 * @returns {Promise<{success:boolean, ref:string|null, record_id:string|null, error:string|null}>}
 */
async function countersignVoltBundle(bundleManifest) {
  try {
    const mod = await import('./lib/sinks/quox-verified.js');
    const config = mod.resolveQuoxVerifiedConfig();
    return await mod.countersignVoltBundle(bundleManifest, config);
  } catch (err) {
    return { success: false, ref: null, record_id: null, error: err.message };
  }
}

/**
 * Shut down WARD hooks.
 */
async function closeWardHooks() {
  if (!_hooks) return;
  try {
    _hooks.closeWardHooks();
  } catch (err) {
    console.warn('[WARD] Close error:', err.message);
  }
}

/**
 * EVD-2: Get the persistent Ed25519 signing keypair used by WARD.
 * Returns { publicKey, privateKey, keyId } or null if WARD not initialised.
 * Reused by VOLT bundle signing so that signatures are verifiable across
 * runs — the previous ephemeral-key approach was unverifiable.
 */
function getHookKeypair() {
  if (!_hooks) return null;
  try {
    return _hooks.getHookKeypair ? _hooks.getHookKeypair() : null;
  } catch (err) {
    console.warn('[WARD] getHookKeypair error:', err.message);
    return null;
  }
}

/**
 * QUOXTRUST FND_..SB5J + FND_..SQJP — WARD hooks readiness + dropped-witness accounting, for /health.
 * ready:false with dropped>0 (or a loadError) is a witness OUTAGE that must alarm.
 * SQJP: `ready` now reflects ACTUAL witnessing (isWardActive = initialized && enabled), not merely
 * that the module IMPORTED — a runtime initWardHooks() failure left initialized:false while ready
 * reported true (all-clear) and every witness call silently no-op'd. Also surfaces witnessErrors
 * (runtime witness-write failures, previously console.warn-only) and signingEnabled (a keypair-load
 * failure left tips silently UNSIGNED with no health signal, T8).
 * @returns {{ready:boolean, loadError:string|null, dropped:{aee:number,aocl:number,volt:number}, droppedTotal:number, witnessErrors:number, signingEnabled:boolean}}
 */
function wardHooksStatus() {
  let active = false;
  let signingEnabled = false;
  let witnessErrors = 0;
  if (_hooks) {
    try { active = typeof _hooks.isWardActive === 'function' ? !!_hooks.isWardActive() : true; } catch { active = false; }
    try { signingEnabled = typeof _hooks.isSigningEnabled === 'function' ? !!_hooks.isSigningEnabled() : false; } catch { signingEnabled = false; }
    try { witnessErrors = typeof _hooks.getWitnessErrorCount === 'function' ? (_hooks.getWitnessErrorCount() || 0) : 0; } catch { witnessErrors = 0; }
  }
  return {
    // A module that imported but failed to initialise (initialized:false) is NOT ready — it is a
    // silent witness outage; report it so /health alarms instead of lying all-clear.
    ready: !!_hooks && active,
    loadError: _loadError ? _loadError.message : null,
    dropped: { ..._dropped },
    droppedTotal: _dropped.aee + _dropped.aocl + _dropped.volt,
    witnessErrors,
    signingEnabled,
  };
}

module.exports = { initWardHooks, wardHookAEE, wardHookAOCL, wardHookVOLT, wardBatch, countersignVoltBundle, closeWardHooks, getHookKeypair, wardHooksStatus };
