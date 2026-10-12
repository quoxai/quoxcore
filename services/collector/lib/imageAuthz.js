/**
 * ImagesQ object-route authorization (F02 fix).
 *
 * imageStore.getImagePath()/deleteImage() only ever take an image ID — they
 * have no notion of org or owner. requireAuth() on the GET/DELETE
 * /api/v1/images/:id routes proves the caller HAS a valid session, but says
 * nothing about whether that caller is entitled to THIS image. Without this
 * check, a valid session in org B can read or delete an image whose sidecar
 * belongs to org A (e.g. an image ID leaked via a shared message).
 *
 * Authorization model mirrors the existing GET /api/v1/images LIST route,
 * which already scopes strictly by org (server.js forces filters.org_id from
 * the JWT, not the client):
 *   - Image recorded against an org  -> caller must be a member of that org.
 *   - Image recorded with no org_id at all (legacy/internal saves) -> fall
 *     back to an exact owner (user_id) match.
 *   - Neither org nor user recorded on the sidecar -> deny; nothing proves
 *     entitlement, so default-closed rather than default-open.
 */
function canAccessImage(sidecar, requester) {
  if (!sidecar) return false;

  const requesterOrgId = requester?.orgId || requester?.org_id || null;
  const requesterUserId = requester?.id || requester?.userId || null;

  if (sidecar.org_id) {
    return !!requesterOrgId && sidecar.org_id === requesterOrgId;
  }
  if (sidecar.user_id) {
    return !!requesterUserId && sidecar.user_id === requesterUserId;
  }
  return false;
}

module.exports = { canAccessImage };
