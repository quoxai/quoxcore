/**
 * 'x.*' endpoints — the X (Twitter) plugin's governed REST surface on the
 * collector (services/collector/routes/xRoutes.js, mounted at /x with
 * requireServiceOrUserAuth + requirePluginEntitlement('x')).
 *
 * Most `quox x` verbs go through the agent tool path (v1.tools.execute) and
 * need no fragment here. This one is the exception: media upload is a
 * multipart REST route, so the CLI posts a FormData body straight to it
 * (quox#592 — the media-upload gap: the endpoint existed for the dashboard
 * Compose UI but had no CLI reach).
 *
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const x = {
  'x.media.upload': {
    method: 'POST',
    service: 'collector',
    path: () => `/x/media`,
    tags: ['live-write'],
  },
};

export default x;
