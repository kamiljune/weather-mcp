/** Auth0 JWT verification and Garmin-backed Weather authorization. */

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

export function createAuth0TokenVerifier(config: HttpConfig): TokenVerifier {
  const issuer = `https://${config.auth0Domain}/`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
  return async (token: string): Promise<JWTPayload> => {
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer,
        audience: config.auth0Audience,
        algorithms: ['RS256']
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
    private readonly verifyToken: TokenVerifier = createAuth0TokenVerifier(config),
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

