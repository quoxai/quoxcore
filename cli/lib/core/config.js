/**
 * Config management for QuoxCLI
 *
 * Stores profiles and auth tokens in ~/.config/quox/config.json
 * File permissions: 0600 (owner read/write only)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, openSync, closeSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function getConfigDir() { return join(homedir(), '.config', 'quox'); }
function getConfigFile() { return join(getConfigDir(), 'config.json'); }

// quox#713: cross-process lock around read-merge-write of config.json.
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 15000;
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function debugLog(msg) { if (process.env.QUOX_DEBUG) process.stderr.write(`[quox config] ${msg}\n`); }
function acquireLock(lockFile) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
          debugLog('breaking stale config lock');
          try { unlinkSync(lockFile); } catch { /* another breaker won */ }
          continue;
        }
      } catch { continue; /* lock vanished, retry */ }
      if (Date.now() > deadline) return false;
      sleepSync(15);
    }
  }
}
function releaseLock(lockFile) { try { unlinkSync(lockFile); } catch { /* already gone */ } }
const J = (v) => JSON.stringify(v === undefined ? null : v);

const DEFAULT_CONFIG = {
  version: 1,
  activeProfile: 'local',
  profiles: {
    local: {
      url: 'http://localhost:3000',
      auth: null,
    },
  },
};

// Service port map matching docker-compose.yml
export const SERVICE_PORTS = {
  auth: 3101,
  files: 3102,
  memory: 3103,
  orchestrator: 3100,
  tasks: 3104,
  collector: 9848,
  // WP2.2: quoxflow exposes 127.0.0.1:${QUOXFLOW_PORT:-3200}:3200 in
  // docker-compose.yml. This entry was previously absent, which silently
  // broke getServiceUrl('quoxflow') — step 3 below only rewrites the port
  // when a SERVICE_PORTS entry exists, so without it the call fell through
  // to the unmodified base URL (wrong port). doctor.js has referenced
  // `service: 'quoxflow', port: 3200` since CLI-3b without this entry ever
  // backing it — that health check was likely silently probing the wrong
  // port. See cli/lib/api/endpoints/triggers.js header for the full
  // quoxflow-access decision this fixes.
  quoxflow: 3200,
  quoxbrain: 3106,
};

// Hosts where a SERVICE_PORTS rewrite necessarily lands on a plain node HTTP
// server rather than on nginx. URL.hostname keeps the brackets for IPv6, so
// '[::1]' is the form to match. See getServiceUrl step 3 for the rule.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// #572/#623: RFC1918 private-LAN hosts (+ *.local). On a single-box Quox stack
// the compose services bind 127.0.0.1 and ONLY the edge (:3000) terminates TLS
// and answers on the LAN address — so a service-port derived from a private-LAN
// base (e.g. https://quox.example.com:3000) must point at the reachable loopback
// bind, not https://<lan-ip>:PORT (which returns 000/refused, made `quox doctor`
// cry CRITICAL and broke run/objective/memory/volt). PUBLIC/remote hosts are
// deliberately NOT matched: they may run a real per-port TLS-terminating
// deployment, and an explicit per-service override always wins regardless.
function isPrivateHost(hostname) {
  if (/\.local$/i.test(hostname)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const a = Number(m[1]); const b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Pure port-swap derivation, extracted so it is unit-testable without a
// full config/profile fixture. Given a base URL (normally the ACTIVE
// profile's own `url`, never a global default), swap in the target
// service's port and return the origin. See getServiceUrl step 3 for the
// loopback scheme-downgrade rule this also carries.
//
// DEVSUITE-GRIPE-P7 / Bug A: this used to be computed from getBaseUrl(),
// which honours the global QUOX_URL env override BEFORE the active
// profile's own url. That meant `-p <profile>` picked which profile's
// token/services were used, but a QUOX_URL left set in the shell silently
// overrode which HOST every derived service URL (auth, memory, etc.)
// pointed at — `quox -p vulcan-proof signup ...` derived the auth base
// from whatever QUOX_URL said, not from vulcan-proof's own url. Deriving
// directly from the profile url here means -p is authoritative for service
// URL derivation the same way it already is for auth/services overrides.
export function deriveServiceUrl(baseUrl, port) {
  try {
    const url = new URL(baseUrl);
    url.port = String(port);
    if (LOOPBACK_HOSTS.has(url.hostname)) {
      // Loopback base: force http (compose services are plain HTTP); keep the
      // hostname as-is (localhost stays localhost — already reachable).
      url.protocol = 'http:';
    } else if (isPrivateHost(url.hostname)) {
      // Private-LAN base: the service binds loopback, so point at the reachable
      // bind (#572/#623). Public/remote hosts fall through unchanged.
      url.protocol = 'http:';
      url.hostname = '127.0.0.1';
    }
    return url.origin;
  } catch {
    return baseUrl;
  }
}

// -p/--profile must be resolved BEFORE commander parses argv: bin/quox.js
// builds the shared ctx (loadConfig) at module load, when program.opts() is
// still empty. Reading the flag there always yielded undefined, so -p
// silently fell back to activeProfile — a login aimed at a dedicated profile
// clobbered another profile's session on 2026-08-15. This pre-scan is the
// only correct source for the flag at ctx-build time.
// Commands whose remaining argv belongs to another program (`quox claude -p
// "prompt"` is claude's --print, not quox's --profile).
const WRAPPED_PROGRAM_COMMANDS = new Set(['claude', 'codex', 'gemini', 'wrap']);

export function resolveProfileFlagFromArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (WRAPPED_PROGRAM_COMMANDS.has(a)) return undefined;
    if (a === '-p' || a === '--profile') return argv[i + 1];
    if (typeof a === 'string' && a.startsWith('--profile=')) return a.slice('--profile='.length);
  }
  return undefined;
}

// fleet #479: -p/--profile and QUOX_PROFILE are documented as a one-shot
// override, but loadConfig used to write the override straight onto
// config.activeProfile. Any later save() (e.g. a login) then persisted it,
// silently changing the user's default profile for every command after.
// An override is a lens, not a switch: it must never survive to disk unless
// the caller explicitly asks for that with setActiveProfile(). The fix
// keeps the persisted default in _data.activeProfile untouched and tracks
// the "profile this invocation is using" separately on the wrapper as
// _effectiveProfile. Every reader that means "current" reads that; only
// setActiveProfile() is allowed to move the persisted default.
// #736 (2026-10-09): a config file that cannot be parsed must never be
// replaced by defaults in silence. The disk filled, the file became
// unreadable for a moment, and the next save wrote a near-empty config over
// every profile. Recover from the last good copy, or keep the bad file aside.
function moveConfigAside(reason) {
  try {
    const aside = `${getConfigFile()}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(getConfigFile(), aside);
    process.stderr.write(`Warning: ${getConfigFile()} was unreadable (${reason}); kept it as ${aside}.\n`);
  } catch { /* nothing to move */ }
}
function recoverConfig(reason) {
  const bak = `${getConfigFile()}.bak`;
  try {
    const parsed = JSON.parse(readFileSync(bak, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.profiles) {
      moveConfigAside(reason);
      process.stderr.write(`Recovered quox config from ${bak}.\n`);
      return parsed;
    }
  } catch { /* no usable backup */ }
  moveConfigAside(reason);
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

export function loadConfig(profileOverride) {
  let config;

  if (existsSync(getConfigFile())) {
    try {
      config = JSON.parse(readFileSync(getConfigFile(), 'utf-8'));
      if (!config || typeof config !== 'object') throw new Error('not an object');
    } catch (err) {
      config = recoverConfig(err.message);
    }
  } else {
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  // Ensure structure
  if (!config.profiles) config.profiles = {};
  if (!config.activeProfile) config.activeProfile = 'local';

  // Profile override from CLI flag or env. This is session-scoped state
  // only: it must never be assigned onto config.activeProfile (the
  // persisted default), see comment block above.
  const effectiveProfile = profileOverride || process.env.QUOX_PROFILE || config.activeProfile;
  // A NAMED override that doesn't exist yet is only legitimate for commands
  // that create it (login, config profile add) — warn instead of silently
  // proceeding on an empty profile, so a typo'd -p never masquerades as a
  // logged-out state.
  if (profileOverride && config.profiles && !config.profiles[profileOverride]) {
    process.stderr.write(`Note: profile "${profileOverride}" does not exist yet; it will be created on login.\n`);
    // Vivify in memory so login's setAuth() has a slot to write (persisted
    // only when a mutation saves); read-only commands just see a logged-out
    // profile, which is the accurate answer. A later save() (e.g. login)
    // persists this profile entry, but never the activeProfile default.
    config.profiles[profileOverride] = {
      url: (config.profiles[config.activeProfile] || {}).url || DEFAULT_CONFIG.profiles.local.url,
      auth: null,
    };
  }

  return {
    _data: config,
    // The profile this invocation is using (persisted default, or the -p /
    // QUOX_PROFILE override for this process only). Never written to _data.
    _effectiveProfile: effectiveProfile,
    // quox#805: a profile passed explicitly to loadConfig(profile) means "act as
    // that profile's user", same as -p on the CLI (no implicit attach default).
    _explicitProfile: Boolean(profileOverride),

    getActiveProfile() {
      const name = this._effectiveProfile;
      return this._data.profiles[name] || null;
    },

    getActiveProfileName() {
      return this._effectiveProfile;
    },

    // The ONLY deliberate persistent switch: moves the on-disk default AND
    // the effective name, then saves. Everything else in this file is a
    // session-scoped lens onto whichever name is current.
    setActiveProfile(name) {
      if (!this._data.profiles[name]) {
        throw new Error(`Profile "${name}" does not exist.`);
      }
      this._data.activeProfile = name;
      this._effectiveProfile = name;
      this.save();
    },

    addProfile(name, opts = {}) {
      if (this._data.profiles[name]) {
        throw new Error(`Profile "${name}" already exists.`);
      }
      this._data.profiles[name] = {
        url: opts.url || 'http://localhost:3000',
        auth: null,
      };
      this.save();
    },

    removeProfile(name) {
      if (name === this._effectiveProfile) {
        throw new Error('Cannot remove the active profile. Switch first.');
      }
      delete this._data.profiles[name];
      // quox#527: save() merges profiles it finds on disk but does not know
      // about (so a parallel session's new profile survives our write). An
      // EXPLICIT removal must not be resurrected by that merge.
      this._removedProfiles.add(name);
      this.save();
    },

    listProfiles() {
      return Object.entries(this._data.profiles).map(([name, profile]) => ({
        name,
        url: profile.url,
        active: name === this._effectiveProfile,
        loggedIn: !!profile.auth?.access_token,
        email: profile.auth?.email || null,
        orgId: profile.auth?.org_id || null,
      }));
    },

    // Resident profiles (auth.kind === 'resident') are the durable,
    // passwordless credential for unattended automation: no refresh token and
    // no server-side session row to revoke, they re-authenticate via a signed
    // Ed25519 challenge on every 401 (see residentAuth.js). When a password
    // session dead-ends (revoked/expired) the CLI used to loop agents through
    // `quox login` — a human action an unattended agent cannot take — so this
    // lets the dead-end paths point at the resident profile instead.
    // Added devtooling-fix 2026-09-10 after the owner was re-logging-in for an
    // agent repeatedly while a working resident profile sat unused.
    listResidentProfiles() {
      return Object.entries(this._data.profiles)
        .filter(([, p]) => p?.auth?.kind === 'resident')
        .map(([name, p]) => ({
          name,
          orgId: p.auth?.org_id || null,
          email: p.auth?.email || null,
        }));
    },

    getAuth() {
      // Env var override
      if (process.env.QUOX_TOKEN) {
        return { access_token: process.env.QUOX_TOKEN };
      }
      return this.getActiveProfile()?.auth || null;
    },

    // quox#455 gap 2: a resident bootstrap carries per-service reach-back
    // URLs discovered at enable time (the instance edge, the collector's
    // real scheme+port). Persist them onto the ACTIVE profile so every
    // later command resolves services from what the host actually reaches,
    // instead of deriving them by port/scheme guesswork.
    setProfileConnection({ url, services } = {}) {
      const profile = this.getActiveProfile();
      if (!profile) throw new Error('No active profile.');
      if (url) profile.url = url;
      if (services && typeof services === 'object') {
        profile.services = { ...(profile.services || {}), ...services };
      }
      this.save();
    },

    setAuth(authData, opts = {}) {
      const profile = this.getActiveProfile();
      if (!profile) throw new Error('No active profile.');
      profile.auth = authData;
      if (opts.refresh) this._refreshedAuth.add(this._effectiveProfile);
      else this._refreshedAuth.delete(this._effectiveProfile);
      this.save();
    },

    // opts.refresh: the clear is a reaction to a refresh rejection from this
    // process's (possibly stale) session; it must not wipe a newer login.
    clearAuth(opts = {}) {
      const profile = this.getActiveProfile();
      if (profile) {
        profile.auth = null;
        this._clearedAuth.add(this._effectiveProfile);
        if (opts.refresh) this._refreshedAuth.add(this._effectiveProfile);
        else this._refreshedAuth.delete(this._effectiveProfile);
      }
      this.save();
    },

    getBaseUrl() {
      // Env var override
      if (process.env.QUOX_URL) return process.env.QUOX_URL;
      return this.getActiveProfile()?.url || 'http://localhost:3000';
    },

    getServiceUrl(service) {
      // 1. Per-service env var override (e.g. QUOX_AUTH_URL, QUOX_BASTION_URL)
      const envKey = `QUOX_${service.toUpperCase()}_URL`;
      if (process.env[envKey]) return process.env[envKey];

      // 1.5. Per-profile service overrides (quox#455: stamped by resident
      // login from the enable-time bootstrap; what the host truly reaches)
      const profileServices = this.getActiveProfile()?.services;
      if (profileServices && profileServices[service]) return profileServices[service];

      // 2. Shared services config (for external services: bastion, quoxagent, etc.)
      const services = this._data.services;
      if (services && services[service]) return services[service];

      // 3. Known service port map (for docker-compose services).
      //
      // DEVSUITE-GRIPE-P7 / Bug A: derive from the ACTIVE PROFILE's own url,
      // never getBaseUrl() — getBaseUrl() honours the global QUOX_URL env
      // override ahead of the profile, which let a stale QUOX_URL silently
      // defeat an explicit -p/--profile selection for every service-port
      // derivation (auth, memory, etc.) while the profile still correctly
      // held its own token/services. -p must be authoritative here the same
      // way it already is for the overrides above. A default-config fallback
      // (no active profile at all) still falls back to the documented
      // default base, matching getBaseUrl()'s own no-profile fallback.
      const profileUrl = this.getActiveProfile()?.url
        || (process.env.QUOX_URL) // no active profile: nothing more specific to prefer
        || 'http://localhost:3000';
      const port = SERVICE_PORTS[service];
      if (!port) return this.getBaseUrl();

      // Replace the port in the base URL.
      //
      // BRAIN2-AUDIT 2026-09-12: the port rewrite used to keep the base URL's
      // scheme, so a profile pointed at https://localhost:3000 (nginx, the
      // ONLY TLS terminator in docker-compose.yml) derived
      // https://localhost:3106 for quoxbrain — every docker-compose service
      // port is a plain node HTTP server, so the TLS handshake never
      // completed and the call died as "fetch failed". `quox brain status`
      // had plausibly never worked against this deployment shape (the
      // product's own usage ledger recorded zero CLI brain calls).
      // On a LOOPBACK host, a port-map rewrite therefore forces http:. This
      // is deliberately narrow: it applies only to this derivation step, so
      // env-var overrides (step 1), per-profile service overrides (step 1.5)
      // and the shared services config (step 2) still say exactly what they
      // say, and a remote/non-loopback host keeps its scheme (a real
      // deployment may terminate TLS per port).
      return deriveServiceUrl(profileUrl, port);
    },

    get(key) {
      // quox#570: url is a PROFILE field. Every reader (getBaseUrl, service
      // derivation) prefers the active profile's url, so get must read the
      // same place set writes or a set/get round-trip lies.
      if (key === 'url') {
        const profile = this.getActiveProfile();
        if (profile) return profile.url;
      }
      return this._data[key];
    },

    set(key, value) {
      const PROTECTED = new Set(['version', 'profiles', 'activeProfile']);
      if (PROTECTED.has(key)) {
        throw new Error(`Cannot set protected key "${key}". Use profile commands instead.`);
      }
      // quox#570: `config set url` used to write a top-level `url` key that
      // no reader consults, so repointing a profile silently kept the old
      // host. Route it to the effective profile (which honours -p) when one
      // exists; top-level stays the fallback for a profile-less config.
      if (key === 'url') {
        const profile = this.getActiveProfile();
        if (profile) {
          profile.url = value;
          this.save();
          return;
        }
      }
      this._data[key] = value;
      this.save();
    },

    // quox#527: parallel sessions share this file. Two protections:
    // (1) merge-on-save: profiles present on disk that THIS process has
    //     never seen are kept (a sibling session's fresh login/profile is
    //     not wiped by our unrelated write); explicit removals recorded in
    //     _removedProfiles win over the merge so deletion stays deletion.
    // (2) atomic write: temp file + rename, so a concurrent reader never
    //     sees a torn/partial JSON file.
    // The narrower last-writer-wins on a SHARED profile's fields remains —
    // that needs a lock, not a merge — but "my profile vanished mid-session"
    // (the filed symptom) is closed by (1).
    _removedProfiles: new Set(),
    // (3) 2026-10-05: a profile this process LOADED but never changed is not
    //     ours to write. Background processes refreshing `resident` were
    //     writing their stale copy of `moo` over a fresh `quox -p moo login`
    //     seconds later. Snapshot each profile at load; an unchanged one
    //     takes the on-disk version on save.
    _loadedProfiles: Object.fromEntries(Object.entries(config.profiles || {}).map(([n, v]) => [n, JSON.stringify(v)])),

    // quox#713: save() is PROFILE-SCOPED and FIELD-SCOPED. Under config.json.lock
    // it re-reads the file and applies only the fields this process changed
    // relative to what it loaded (snapshot diff). Rules:
    //  - an unchanged profile/field is never written;
    //  - auth becomes null only via an explicit clearAuth() on that profile;
    //  - a REFRESH (setAuth(a, {refresh:true})) never overwrites an on-disk
    //    auth that differs from the one this process loaded (a newer login or
    //    sibling refresh happened meanwhile): disk wins.
    _clearedAuth: new Set(),
    _refreshedAuth: new Set(),
    _loadedTop: Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'profiles').map(([k, v]) => [k, J(v)])),

    save() {
      if (!existsSync(getConfigDir())) {
        mkdirSync(getConfigDir(), { recursive: true });
      }
      const lockFile = `${getConfigFile()}.lock`;
      const locked = acquireLock(lockFile);
      if (!locked) debugLog('could not acquire config lock, writing unlocked');
      try {
        let disk = null;
        try {
          disk = JSON.parse(readFileSync(getConfigFile(), 'utf-8'));
          if (!disk || typeof disk !== 'object') disk = null;
        } catch { /* no file yet, or unreadable JSON */ }
        // #736: an existing file we cannot parse is kept aside, never overwritten.
        if (!disk && existsSync(getConfigFile())) moveConfigAside('unreadable at save');
        const out = disk || JSON.parse(JSON.stringify(this._data));
        if (!out.profiles) out.profiles = {};
        if (disk) {
          // top-level keys (activeProfile, services, ...): only ones we changed
          for (const [k, v] of Object.entries(this._data)) {
            if (k === 'profiles') continue;
            if (this._loadedTop[k] !== J(v)) out[k] = v;
          }
          for (const name of Object.keys(this._data.profiles)) {
            if (this._removedProfiles.has(name)) continue;
            const mine = this._data.profiles[name];
            const loaded = this._loadedProfiles[name] === undefined ? undefined : JSON.parse(this._loadedProfiles[name]);
            const wasCleared = this._clearedAuth.has(name);
            if (loaded !== undefined && J(mine) === J(loaded) && !wasCleared) continue; // untouched
            const target = out.profiles[name];
            if (target === undefined) { out.profiles[name] = JSON.parse(JSON.stringify(mine)); continue; }
            for (const key of new Set([...Object.keys(mine), ...Object.keys(loaded || {})])) {
              if (loaded && J(mine[key]) === J(loaded[key]) && !(key === 'auth' && wasCleared)) continue;
              if (key === 'auth') {
                if (mine.auth == null && !wasCleared) { debugLog(`refusing implicit null auth for ${name}`); continue; }
                if (this._refreshedAuth.has(name) && target.auth != null && J(target.auth) !== J(loaded?.auth)) {
                  debugLog(`keeping newer on-disk auth for ${name} over refresh from older session`);
                  continue;
                }
              }
              if (mine[key] === undefined) delete target[key]; else target[key] = mine[key];
            }
          }
          for (const name of this._removedProfiles) delete out.profiles[name];
        }
        // adopt merged result in memory (in place, callers hold profile refs)
        for (const [name, prof] of Object.entries(out.profiles)) {
          const cur = this._data.profiles[name];
          if (cur && cur !== prof) {
            for (const k of Object.keys(cur)) delete cur[k];
            Object.assign(cur, prof);
          } else if (!cur) {
            this._data.profiles[name] = prof;
          }
        }
        for (const [k, v] of Object.entries(out)) if (k !== 'profiles') this._data[k] = v;
        const tmpFile = `${getConfigFile()}.tmp-${process.pid}`;
        try {
          writeFileSync(tmpFile, JSON.stringify(out, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
        } catch (err) {
          // ENOSPC and friends: never leave a stray tmp, never touch config.json.
          try { unlinkSync(tmpFile); } catch { /* not created */ }
          throw err;
        }
        try {
          chmodSync(tmpFile, 0o600);
        } catch {
          // May fail on Windows, acceptable
        }
        // #736: keep the last GOOD config as .bak before replacing it.
        if (disk) {
          try { copyFileSync(getConfigFile(), `${getConfigFile()}.bak`); chmodSync(`${getConfigFile()}.bak`, 0o600); } catch { /* best effort */ }
        }
        renameSync(tmpFile, getConfigFile());
        this._loadedProfiles = Object.fromEntries(Object.entries(this._data.profiles || {}).map(([n, v]) => [n, J(v)]));
        this._loadedTop = Object.fromEntries(Object.entries(this._data).filter(([k]) => k !== 'profiles').map(([k, v]) => [k, J(v)]));
        this._clearedAuth.clear();
        this._refreshedAuth.clear();
      } finally {
        if (locked) releaseLock(lockFile);
      }
    },
  };
}
