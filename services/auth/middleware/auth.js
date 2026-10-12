/**
 * Auth middleware - convenience wrapper for authenticate
 *
 * Provides simpler requireAuth export for Phase B routes
 */

import { authenticate } from './authenticate.js';

/**
 * requireAuth - middleware that requires authentication
 * Use: router.get('/endpoint', requireAuth, handler)
 */
export const requireAuth = authenticate({ required: true });

/**
 * optionalAuth - middleware that loads user if token present but doesn't require it
 * Use: router.get('/endpoint', optionalAuth, handler)
 */
export const optionalAuth = authenticate({ required: false });

// Re-export everything from authenticate for convenience
export * from './authenticate.js';
