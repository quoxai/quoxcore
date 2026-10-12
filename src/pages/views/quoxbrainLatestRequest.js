// BRAIN2-W7 E 132: request-identity guard. begin() returns a token; isCurrent(token)
// is true only for the most recently begun request, so a slow earlier response
// (old filter or old org) can never replace the state a newer one produced.
export function createLatestGuard() {
  let latest = 0
  return {
    begin() { latest += 1; return latest },
    isCurrent(token) { return token === latest },
    invalidate() { latest += 1 },
  }
}
