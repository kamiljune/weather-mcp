/** OIDC JWT verification and Garmin-backed Weather authorization. */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { HttpConfig } from '../config/http.js';

export type AuthFailureKind = 'unauthorized' | 'forbidden' | 'unavailable';

export class AuthFailure extends Error {
  constructor(readonly kind: AuthFailureKind, message: string) {
    super(message);
    this.name = 'AuthFailure';
  }
}

export interface WeatherAuthorizer {
  authorize(rawToken: string): Promise<{ slug: string }>;
}

export type TokenVerifier = (token: string) => Promise<JWTPayload>;
export type FetchLike = typeof fetch;

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Asymmetric JWS algorithms only. HS* (shared secret) and "none" are never accepted,
 * which rules out algorithm-confusion attacks; jose additionally requires the key type
 * to match the token's alg. Logto signs ES384, Auth0 RS256.
 */
const ASYMMETRIC_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

/** Discovery URL in path-appending form (the only form Logto serves). */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

/**
 * OIDC access-token verifier. Only the issuer is configured; the JWKS location comes
 * from the IdP's discovery document. Discovery is fetched lazily and cached; a failure
 * is not cached, so the next request retries, and it fails closed as "unavailable".
 */
export function createOidcTokenVerifier(config: HttpConfig, fetchImpl: FetchLike = fetch): TokenVerifier {
  let jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;

  const loadJwks = async () => {
    const res = await fetchImpl(discoveryUrl(config.oidcIssuer), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
    const doc = await res.json() as { issuer?: unknown; jwks_uri?: unknown };
    if (doc.issuer !== config.oidcIssuer) throw new Error('discovery issuer mismatch');
    if (typeof doc.jwks_uri !== 'string') throw new Error('discovery has no jwks_uri');
    return createRemoteJWKSet(new URL(doc.jwks_uri));
  };

  return async (token: string): Promise<JWTPayload> => {
    let jwks: ReturnType<typeof createRemoteJWKSet>;
    try {
      jwksPromise ??= loadJwks();
      jwks = await jwksPromise;
    } catch {
      jwksPromise = null;
      throw new AuthFailure('unavailable', 'The identity provider is unavailable.');
    }
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer: config.oidcIssuer,
        audience: config.oidcAudience,
        algorithms: ASYMMETRIC_ALGS
      });
      if (typeof verified.payload.sub !== 'string' || verified.payload.sub === '') {
        throw new Error('missing sub');
      }
      return verified.payload;
    } catch {
      throw new AuthFailure('unauthorized', 'The OAuth access token is invalid or expired.');
    }
  };
}

export class GarminBackedAuthorizer implements WeatherAuthorizer {
  constructor(
    private readonly config: HttpConfig,
    private readonly verifyToken: TokenVerifier = createOidcTokenVerifier(config),
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async authorize(rawToken: string): Promise<{ slug: string }> {
    await this.verifyToken(rawToken);

    let response: Response;
    try {
      response = await this.fetchImpl(this.config.garminAuthzUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${rawToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(2000)
      });
    } catch {
      throw new AuthFailure('unavailable', 'The user authorization service is unavailable.');
    }

    if (response.status === 401) {
      throw new AuthFailure('unauthorized', 'The OAuth access token is invalid or expired.');
    }
    if (response.status === 403) {
      throw new AuthFailure('forbidden', 'This account is not authorized to use Weather MCP.');
    }
    if (!response.ok) {
      throw new AuthFailure('unavailable', 'The user authorization service is unavailable.');
    }

    let payload: unknown;
    try { payload = await response.json(); } catch {
      throw new AuthFailure('unavailable', 'The user authorization service returned an invalid response.');
    }
    const slug = (payload as { slug?: unknown }).slug;
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
      throw new AuthFailure('unavailable', 'The user authorization service returned an invalid identity.');
    }
    return { slug };
  }
}

