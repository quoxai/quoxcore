/**
 * WebSocket Authentication for Quox Collector
 *
 * Security fix for issue #65: Unauthenticated WebSocket connections
 *
 * Verifies JWT tokens on WebSocket connection/upgrade to ensure
 * only authenticated users can connect to the real-time fleet updates.
 */

const jwt = require('jsonwebtoken');
const { URL } = require('url');

// JWT secret - must match auth service
// Issue #166 fix: Removed hardcoded fallback that undermined all auth
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required for WebSocket auth');
  console.error('Set JWT_SECRET to a secure random value matching the auth service');
  process.exit(1);
}

// Connection timeout for unauthenticated connections (10 seconds)
const AUTH_TIMEOUT_MS = parseInt(process.env.WS_AUTH_TIMEOUT_MS, 10) || 10000;

// M4 fix: WS_ALLOW_UNAUTHENTICATED feeds /terminal/ws -> nodePty.spawn, i.e.
// an unauthenticated PTY RCE toggle. It must be IMPOSSIBLE in production —
// only honored when NODE_ENV is explicitly the genuine dev profile
// ('development'). Read fresh on every call (not cached at module load) so
// the gate can never be bypassed by an env var set/changed after boot, and
// so it reflects the CURRENT NODE_ENV rather than whatever it was at import
// time.
function isDevProfile() {
  return process.env.NODE_ENV === 'development';
}

function isUnauthAllowed() {
  const flagRequested = process.env.WS_ALLOW_UNAUTHENTICATED === 'true';
  if (!flagRequested) return false;
  if (!isDevProfile()) {
    console.error(
      `[WS-Auth] SECURITY: WS_ALLOW_UNAUTHENTICATED=true ignored — NODE_ENV is ` +
      `"${process.env.NODE_ENV || 'unset'}", not the explicit "development" dev profile. ` +
      `Unauthenticated WebSocket/PTY connections are never permitted outside genuine dev.`
    );
    return false;
  }
  return true;
}

/**
 * Extract JWT token from WebSocket upgrade request
 * Checks: query parameter 'token', cookie 'access_token', Authorization header
 *
 * @param {http.IncomingMessage} req - The upgrade request
 * @returns {string|null} - The token or null
 */
function extractToken(req) {
  // 1. Check query parameter (WebSocket connections typically use this)
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const queryToken = url.searchParams.get('token');
    if (queryToken) {
      return queryToken;
    }
  } catch (e) {
    // URL parsing failed, continue to other methods
  }

  // 2. Check Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 3. Check cookie (requires cookie parsing)
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies.access_token) {
    return cookies.access_token;
  }

  return null;
}

/**
 * Simple cookie parser
 * @param {string} cookieHeader - Cookie header value
 * @returns {object} - Parsed cookies
 */
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name && rest.length > 0) {
      cookies[name.trim()] = rest.join('=').trim();
    }
  });

  return cookies;
}

/**
 * Verify JWT token and extract payload
 * @param {string} token - JWT token
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
// CORTEX-BENCH 2026-10-08 (collector CPU profile): jsonwebtoken rebuilt a
// key object from the string secret on EVERY verify, and dashboard pollers
// re-send the same token many times a minute (~1.2s of main-thread CPU per
// 90s). The secret becomes a KeyObject once, and a successful verification is
// remembered briefly: never past the token's own exp, at most 30s, bounded.
// This is a pure signature check (no revocation lookup), so the cache opens
// no acceptance window beyond the token's own lifetime.
const crypto = require('crypto');
const JWT_KEY = JWT_SECRET ? crypto.createSecretKey(Buffer.from(JWT_SECRET, 'utf8')) : null;
const VERIFY_CACHE_MS = 30000;
const VERIFY_CACHE_MAX = 2000;
const _verifyCache = new Map(); // token -> { payload, until }

function verifyToken(token) {
  if (!token) {
    return { valid: false, error: 'No token provided' };
  }

  const now = Date.now();
  const hit = _verifyCache.get(token);
  if (hit && hit.until > now) return { valid: true, payload: { ...hit.payload } };
  if (hit) _verifyCache.delete(token);

  try {
    const payload = jwt.verify(token, JWT_KEY || JWT_SECRET, { algorithms: ['HS256'] });

    // Verify token type is 'access'
    if (payload.type !== 'access') {
      return { valid: false, error: 'Invalid token type' };
    }

    const expMs = Number.isFinite(payload.exp) ? payload.exp * 1000 : now + VERIFY_CACHE_MS;
    _verifyCache.set(token, { payload: { ...payload }, until: Math.min(expMs, now + VERIFY_CACHE_MS) });
    while (_verifyCache.size > VERIFY_CACHE_MAX) _verifyCache.delete(_verifyCache.keys().next().value);

    return { valid: true, payload };
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return { valid: false, error: 'Token expired' };
    }
    if (err.name === 'JsonWebTokenError') {
      return { valid: false, error: 'Invalid token' };
    }
    return { valid: false, error: 'Token verification failed' };
  }
}

/**
 * Authenticate WebSocket upgrade request
 * @param {http.IncomingMessage} req - The upgrade request
 * @returns {{ authenticated: boolean, user?: object, error?: string }}
 */
function authenticateWebSocket(req) {
  // Allow unauthenticated if explicitly enabled AND in a genuine dev profile
  if (isUnauthAllowed()) {
    console.warn('[WS-Auth] WARNING: Unauthenticated WebSocket connections allowed (WS_ALLOW_UNAUTHENTICATED=true, NODE_ENV=development)');
    return { authenticated: true, user: null };
  }

  const token = extractToken(req);

  if (!token) {
    return { authenticated: false, error: 'No authentication token provided' };
  }

  const result = verifyToken(token);

  if (!result.valid) {
    return { authenticated: false, error: result.error };
  }

  return {
    authenticated: true,
    token,
    user: {
      id: result.payload.sub,
      email: result.payload.email,
      orgId: result.payload.org_id
    }
  };
}

/**
 * Create an authenticated WebSocket connection handler
 * Wraps the WebSocket server to enforce authentication
 *
 * @param {WebSocketServer} wss - The WebSocket server
 * @param {function} onAuthenticated - Callback for authenticated connections (ws, req, user)
 */
function createAuthenticatedHandler(wss, onAuthenticated) {
  wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).slice(2, 8);
    const clientIp = req.socket.remoteAddress;

    const authResult = authenticateWebSocket(req);

    if (!authResult.authenticated) {
      console.warn(`[${new Date().toISOString()}] [${clientId}] WebSocket auth failed from ${clientIp}: ${authResult.error}`);

      // Send error message before closing
      ws.send(JSON.stringify({
        type: 'error',
        error: 'authentication_failed',
        message: authResult.error
      }));

      // Close with 4001 (unauthorized) code
      ws.close(4001, authResult.error);
      return;
    }

    // Store user info on the socket for later use
    ws.user = authResult.user;
    ws.clientId = clientId;
    ws.authenticatedAt = Date.now();

    console.log(`[${new Date().toISOString()}] [${clientId}] WebSocket authenticated from ${clientIp}${authResult.user ? ` (user: ${authResult.user.id})` : ' (anonymous)'}`);

    // Call the authenticated handler
    onAuthenticated(ws, req, authResult.user);
  });
}

/**
 * Setup authentication timeout for WebSocket connections
 * If a connection doesn't authenticate within the timeout, it will be closed
 *
 * @param {WebSocket} ws - The WebSocket connection
 * @param {function} onTimeout - Callback when timeout occurs
 * @returns {NodeJS.Timeout} - The timeout handle (call clearTimeout to cancel)
 */
function setupAuthTimeout(ws, onTimeout) {
  return setTimeout(() => {
    if (!ws.user) {
      console.warn(`[WS-Auth] Connection timeout - no authentication within ${AUTH_TIMEOUT_MS}ms`);
      if (onTimeout) {
        onTimeout(ws);
      }
      ws.close(4002, 'Authentication timeout');
    }
  }, AUTH_TIMEOUT_MS);
}

/**
 * Check if WebSocket authentication is required
 * @returns {boolean}
 */
function isAuthRequired() {
  return !isUnauthAllowed();
}

/**
 * Get authentication configuration status
 * @returns {object}
 */
function getAuthConfig() {
  const isDevSecret = JWT_SECRET === 'dev-secret-change-in-production';
  return {
    authRequired: !isUnauthAllowed(),
    timeoutMs: AUTH_TIMEOUT_MS,
    secureSecret: !isDevSecret,
    warning: isDevSecret ? 'Using default JWT_SECRET - set in production!' : null
  };
}

module.exports = {
  extractToken,
  verifyToken,
  authenticateWebSocket,
  createAuthenticatedHandler,
  setupAuthTimeout,
  isAuthRequired,
  getAuthConfig,
  AUTH_TIMEOUT_MS
};
