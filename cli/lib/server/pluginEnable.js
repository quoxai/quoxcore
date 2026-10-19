/**
 * PLUGIN-IMG #1012: `quox plugin enable <id>` starts a paid plugin from its
 * prebuilt PRIVATE image on a self-hosted install.
 *
 * Order, and why:
 *   1. Licence check FIRST. Not entitled: refuse with a clear message and
 *      run nothing on the box (no login, no pull, no compose). The entitlement
 *      read is the same resolved set auth's has-plugin uses (verified,
 *      instance-bound, unexpired leases), via the user-facing
 *      /api/setup/licensing/entitlements read.
 *   2. Pull credential (TODO hook below): the licence server will issue a
 *      short-lived, package-scoped GHCR credential to an instance whose lease
 *      covers the plugin. Until that endpoint ships, the hook returns a clear
 *      "pending" error and enable stops there, unless the image is already
 *      present locally (for example a proving VM where it was loaded by hand),
 *      in which case it starts with --pull never.
 *   3. docker compose -f docker-compose.yml -f docker-compose.images.yml
 *        -f docker-compose.plugins.yml --profile <profile> up -d <service>
 *   4. Health: poll the container's healthcheck until healthy (or time out).
 *
 * Everything that touches the host goes through an injected `sys`
 * (lib/server/sys.js), so tests prove what would run without running it.
 */

/** Plugins that ship as prebuilt images. QuoxPlan only for now. */
export const PLUGIN_IMAGES = Object.freeze({
  quoxplan: Object.freeze({
    service: 'quoxplan',
    profile: 'with-quoxplan',
    container: 'quox-quoxplan',
    image: 'ghcr.io/quoxai/quoxplan',
    registry: 'ghcr.io',
  }),
});

export const COMPOSE_FILES = Object.freeze(['docker-compose.yml', 'docker-compose.images.yml', 'docker-compose.plugins.yml']);

/** The image tag: the install's release tag (QUOX_IMAGE_TAG in .env), else latest. */
export function imageRef(spec, tag) {
  return `${spec.image}:${tag || 'latest'}`;
}

/** The docker compose argv `enable` runs (after `docker`). */
export function composeUpArgs({ project }, spec, { pullNever = false } = {}) {
  return [
    'compose',
    ...(project ? ['-p', project] : []),
    ...COMPOSE_FILES.flatMap((f) => ['-f', f]),
    '--profile', spec.profile,
    'up', '-d',
    ...(pullNever ? ['--pull', 'never'] : []),
    spec.service,
  ];
}

/**
 * TODO(PLUGIN-IMG #1012, owner-gated): fetch a short-lived, package-scoped
 * pull credential from the licence server for this instance's lease. The
 * endpoint does not exist yet (licence-server change, owner deploy word).
 * Contract when it lands: -> { ok: true, registry, username, token, expires_at }
 * and enable logs in with `docker login <registry> -u <username> --password-stdin`.
 */
export async function getPluginPullCredential(_pluginId, _ctx = {}) {
  return {
    ok: false,
    pending: true,
    error: 'pull credential pending licence-server endpoint: the licence server does not issue plugin image pull credentials yet (#1012)',
  };
}

/**
 * Same rule as `quox plugin licence`: a governed plugin is entitled when the
 * resolved entitlements carry it (bare or banded) and, when it is banded,
 * this org holds a seat.
 */
export function entitlementFrom(data, pluginId) {
  const entitlements = Array.isArray(data?.entitlements) ? data.entitlements : [];
  const governed = (Array.isArray(data?.governed) ? data.governed : []).includes(pluginId);
  const match = entitlements.find((e) => e === pluginId || String(e).startsWith(`${pluginId}@`)) || null;
  const band = (data?.org_bands && data.org_bands[pluginId]) || null;
  if (!governed) return { entitled: true, governed: false };
  if (!match) return { entitled: false, governed: true, reason: 'no_entitlement' };
  if (band && band.org_licensed === false) return { entitled: false, governed: true, reason: 'org_not_in_band' };
  return { entitled: true, governed: true };
}

/**
 * @param {object} o
 * @param {string} o.pluginId
 * @param {(pluginId: string) => Promise<{ entitled: boolean, reason?: string }>} o.checkEntitlement
 * @param {{ repoDir: string, project?: string }} o.install
 * @param {{ run: Function }} o.sys
 * @param {string} [o.tag] image tag (QUOX_IMAGE_TAG)
 * @param {Function} [o.getPullCredential]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {number} [o.healthTries]
 * @param {(line: string) => void} [o.log]
 * @returns {Promise<{ ok: boolean, stage: string, message: string, ran: string[][] }>}
 */
export async function enablePlugin({
  pluginId, checkEntitlement, install, sys, tag,
  getPullCredential = getPluginPullCredential,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  healthTries = 30, healthIntervalMs = 2000,
  log = () => {},
}) {
  const ran = [];
  const run = async (cmd, args, opts) => { ran.push([cmd, ...args]); return sys.run(cmd, args, opts); };
  const spec = PLUGIN_IMAGES[pluginId];
  if (!spec) {
    const known = Object.keys(PLUGIN_IMAGES).join(', ');
    return { ok: false, stage: 'unknown', message: `${pluginId} does not ship as a prebuilt plugin image yet (available: ${known}).`, ran };
  }

  let ent;
  try {
    ent = await checkEntitlement(pluginId);
  } catch (err) {
    return { ok: false, stage: 'licence', message: `Could not check the ${pluginId} licence (${err.message}). Nothing was pulled or started.`, ran };
  }
  if (!ent || !ent.entitled) {
    const why = ent?.reason === 'org_not_in_band' ? ' This organisation does not hold one of its seats.' : '';
    return {
      ok: false,
      stage: 'licence',
      message: `${pluginId} is not licensed on this install.${why} Nothing was pulled or started. Run \`quox plugin licence ${pluginId}\` to see the entitlement, then renew or buy the licence.`,
      ran,
    };
  }

  const ref = imageRef(spec, tag);
  let pullNever = false;
  const cred = await getPullCredential(pluginId, { install });
  if (cred && cred.ok) {
    const login = await run('docker', ['login', cred.registry || spec.registry, '-u', cred.username, '--password-stdin'], { stdinText: cred.token });
    if (login.code !== 0) return { ok: false, stage: 'login', message: `docker login to ${cred.registry || spec.registry} failed: ${(login.stderr || '').trim().slice(0, 300)}`, ran };
  } else {
    const local = await run('docker', ['image', 'inspect', ref, '--format', '{{.Id}}']);
    if (local.code !== 0) {
      return { ok: false, stage: 'pull-credential', message: `${pluginId} is licensed, but its image ${ref} is private and ${cred?.error || 'no pull credential is available'}. Nothing was started.`, ran };
    }
    pullNever = true;
    log(`${ref} is already present locally; starting it without a pull.`);
  }

  const up = await run('docker', composeUpArgs(install, spec, { pullNever }), { cwd: install.repoDir });
  if (up.code !== 0) return { ok: false, stage: 'compose', message: `docker compose up for ${spec.service} failed: ${(up.stderr || '').trim().slice(-400)}`, ran };

  for (let i = 0; i < healthTries; i += 1) {
    const h = await run('docker', ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', spec.container]);
    const status = (h.stdout || '').trim();
    if (h.code === 0 && status === 'healthy') {
      return { ok: true, stage: 'healthy', message: `${pluginId} is running (${ref}) and healthy.`, ran };
    }
    if (h.code === 0 && status === 'unhealthy') {
      return { ok: false, stage: 'health', message: `${spec.container} started but reports unhealthy. Check \`docker logs ${spec.container}\`.`, ran };
    }
    await sleep(healthIntervalMs);
  }
  return { ok: false, stage: 'health', message: `${spec.container} did not report healthy in time. Check \`docker logs ${spec.container}\`.`, ran };
}
