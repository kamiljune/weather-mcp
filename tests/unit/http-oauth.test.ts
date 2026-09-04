import { describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { HttpConfig } from '../../src/config/http.js';
import {
  AuthFailure,
  bearerToken,
  createAuth0TokenVerifier,
  GarminBackedAuthorizer
} from '../../src/http/oauth.js';

const config: HttpConfig = {
  host: '127.0.0.1', port: 8080, basePath: '/mcp',
  auth0Domain: 'issuer.example.com',
  auth0Audience: 'https://weather.example.com/mcp',
  publicBaseUrl: 'https://weather.example.com',
  garminAuthzUrl: 'http://garmin-api:8412/internal/weather/identity',
  dataDir: '/tmp/weather-test', rateLimitPerMinute: 0, maxBodyBytes: 1024,
  allowedHosts: [], allowedOrigins: [], jsonResponse: true, chatgptCompat: false
};

describe('OAuth helpers', () => {
  it('accepts only an Authorization Bearer value', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer   abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it('verifies RS256 issuer, audience, expiration and sub', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const { privateKey: foreignPrivateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'test', use: 'sig', alg: 'RS256' }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })) as typeof fetch;
    try {
      const sign = (
        aud: string,
        expires = '5m',
        issuer = 'https://issuer.example.com/',
        key = privateKey,
        sub: string | null = 'auth0|alice'
      ) => {
        let jwt = new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(issuer)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(expires);
        if (sub !== null) jwt = jwt.setSubject(sub);
        return jwt.sign(key);
      };
      const verifier = createAuth0TokenVerifier(config);
      await expect(verifier(await sign(config.auth0Audience))).resolves.toMatchObject({ sub: 'auth0|alice' });
      await expect(verifier(await sign('https://garmin.example.com/mcp'))).rejects.toMatchObject({ kind: 'unauthorized' });
      await expect(verifier(await sign(config.auth0Audience, '0s'))).rejects.toMatchObject({ kind: 'unauthorized' });
      await expect(verifier(await sign(config.auth0Audience, '5m', 'https://other.example.com/'))).rejects.toMatchObject({ kind: 'unauthorized' });
      await expect(verifier(await sign(config.auth0Audience, '5m', 'https://issuer.example.com/', foreignPrivateKey))).rejects.toMatchObject({ kind: 'unauthorized' });
      await expect(verifier(await sign(config.auth0Audience, '5m', 'https://issuer.example.com/', privateKey, null))).rejects.toMatchObject({ kind: 'unauthorized' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('forwards the raw Weather token to Garmin and maps status classes', async () => {
    const verify = vi.fn(async () => ({ sub: 'auth0|alice' }));
    const okFetch = vi.fn(async () => new Response('{"slug":"alice"}', { status: 200 }));
    const authorizer = new GarminBackedAuthorizer(config, verify, okFetch as typeof fetch);
    await expect(authorizer.authorize('raw-token')).resolves.toEqual({ slug: 'alice' });
    expect(okFetch).toHaveBeenCalledWith(config.garminAuthzUrl, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer raw-token' })
    }));

    for (const [status, kind] of [[401, 'unauthorized'], [403, 'forbidden'], [500, 'unavailable']] as const) {
      const failing = new GarminBackedAuthorizer(
        config, verify, vi.fn(async () => new Response('{}', { status })) as typeof fetch
      );
      await expect(failing.authorize('raw-token')).rejects.toEqual(
        expect.objectContaining<AuthFailure>({ kind })
      );
    }
  });

  it('fails closed after one Garmin network failure', async () => {
    const fetchOnce = vi.fn(async () => { throw new Error('network down'); });
    const authorizer = new GarminBackedAuthorizer(
      config,
      vi.fn(async () => ({ sub: 'auth0|alice' })),
      fetchOnce as typeof fetch
    );

    await expect(authorizer.authorize('raw-token')).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });
});
