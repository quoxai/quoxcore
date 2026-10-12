/**
 * QUOXTRUST FND_..SM0Q (tenant isolation, T7) — authoritative org resolution for the
 * security-engagement + compliance routes.
 *
 * THE RULE: the org a request operates on is the AUTHENTICATED identity's org
 * (`req.user.org_id`, set from the verified JWT / mcp token). A caller-supplied org
 * (`req.body.org_id` / `req.query.org_id` / the `x-org-id` / `x-quox-org-id` headers) is honored
 * ONLY for a trusted SERVICE-KEY caller (`req.service`), never for a human/agent user token —
 * otherwise a user whose token carries a falsy org_id (a real, validly-signed state: a user with
 * zero org memberships gets `org_id: null` at auth.js:830) could set `body.org_id` (or the header)
 * to any victim org and the routes would filter the DB by it, reading/writing another tenant's
 * engagements/findings/compliance and even executing live scans cross-org.
 *
 * Returns null when neither an authenticated org nor a service-supplied org is present; every
 * caller already treats a falsy result as "org_id required" (400), so an orgless human is refused
 * rather than served cross-tenant. This is the same discipline as lib/complianceOrgScope.js's
 * resolveComplianceOrgId and the reference-safe route at server.js:9529.
 */
function resolveCallerOrgId(req) {
  return req?.user?.org_id || (req?.service ? (req?.body?.org_id ?? req?.query?.org_id ?? req?.headers?.['x-org-id'] ?? req?.headers?.['x-quox-org-id'] ?? null) : null);
}

module.exports = { resolveCallerOrgId };
