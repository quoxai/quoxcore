/**
 * Credential Resolver
 *
 * Fetches decrypted credentials from the QuoxCORE auth service.
 * Follows the same pattern as collector's getClaudeKeys().
 * NO new database table or encryption — reuses auth service's AES-256-GCM stores.
 */

export interface CredentialResolverConfig {
  /** Auth service URL. Default: http://auth:3101 */
  authServiceUrl?: string;
  /** Cache TTL in milliseconds. Default: 30000 (30s) */
  cacheTtlMs?: number;
  /** Request timeout in milliseconds. Default: 5000 */
  timeoutMs?: number;
}

export interface ClaudeKeys {
  anthropic_api_key?: string;
  claude_oauth_token?: string;
  model?: string;
}

export interface CredentialSet {
  [key: string]: string | undefined;
}

/**
 * Credential resolver that fetches from auth service internal endpoints
 */
export class CredentialResolver {
  private authServiceUrl: string;
  private cacheTtlMs: number;
  private timeoutMs: number;

  // Cache: type -> { data, timestamp }
  private cache = new Map<string, { data: CredentialSet; ts: number }>();

  constructor(config: CredentialResolverConfig = {}) {
    this.authServiceUrl = config.authServiceUrl
      || process.env.AUTH_SERVICE_URL
      || `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
    this.cacheTtlMs = config.cacheTtlMs ?? 30_000;
    this.timeoutMs = config.timeoutMs ?? 5_000;
  }

  /**
   * Get Claude API keys (anthropic_api_key, claude_oauth_token, model)
   */
  async getClaudeKeys(): Promise<ClaudeKeys> {
    return this.fetchCredentials('claude-keys') as Promise<ClaudeKeys>;
  }

  /**
   * Get credentials by type (e.g., 'elevenlabs', 'openai', 'slack')
   * Calls: GET /api/setup/internal/credentials/:type
   */
  async getCredentials(type: string): Promise<CredentialSet> {
    return this.fetchCredentials(`credentials/${type}`);
  }

  /**
   * Get a single credential value by type and key
   */
  async getCredentialValue(type: string, key: string): Promise<string | undefined> {
    const creds = await this.getCredentials(type);
    return creds[key];
  }

  /**
   * Clear the credential cache (force fresh fetch on next call)
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Internal: fetch credentials from auth service with caching
   */
  private async fetchCredentials(endpoint: string): Promise<CredentialSet> {
    const now = Date.now();
    const cached = this.cache.get(endpoint);

    if (cached && (now - cached.ts) < this.cacheTtlMs) {
      return cached.data;
    }

    try {
      const url = `${this.authServiceUrl}/api/setup/internal/${endpoint}`;
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!resp.ok) {
        console.warn(`[CredentialResolver] Failed to fetch ${endpoint}: HTTP ${resp.status}`);
        // Return cached data if available (stale cache is better than no data)
        if (cached) return cached.data;
        return {};
      }

      const data = await resp.json() as CredentialSet;
      this.cache.set(endpoint, { data, ts: now });
      return data;
    } catch (err) {
      console.warn(`[CredentialResolver] Error fetching ${endpoint}:`, (err as Error).message);
      // Return stale cache on error
      if (cached) return cached.data;
      return {};
    }
  }
}

/**
 * Create a credential resolver instance
 */
export function createCredentialResolver(config?: CredentialResolverConfig): CredentialResolver {
  return new CredentialResolver(config);
}
