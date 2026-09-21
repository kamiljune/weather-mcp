import { describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { HttpConfig } from '../../src/config/http.js';
import {
  AuthFailure,
  bearerToken,
  createOidcTokenVerifier,
  GarminBackedAuthorizer
} from '../../src/http/oauth.js';

const config: HttpConfig = {
  host: '127.0.0.1', port: 8080, basePath: '/mcp',
  oidcIssuer: 'https://issuer.example.com/oidc',
  oidcAudience: 'https://weather.example.com/mcp',
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

  const ISSUER = 'https://issuer.example.com/oidc';
  const JWKS_URI = 'https://issuer.example.com/oidc/jwks';

  // Discovery + JWKS served by a fake IdP; `issuer` lets a test make discovery lie.
  function fakeIdp(jwk: object, alg: string, issuer = ISSUER) {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return Response.json({ issuer, jwks_uri: JWKS_URI });
      }
      if (url === JWKS_URI) {
        return Response.json({ keys: [{ ...jwk, kid: 'test', use: 'sig', alg }] });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  async function withFetch<T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
    // jose's remote JWKS uses the global fetch; discovery uses the injected one.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try { return await fn(); } finally { globalThis.fetch = originalFetch; }
  }

  for (const alg of ['RS256', 'ES384']) {
    it(`verifies ${alg} issuer, audience, expiration and sub via discovery`, async () => {
      const { publicKey, privateKey } = await generateKeyPair(alg);
      const { privateKey: foreignPrivateKey } = await generateKeyPair(alg);
      const idp = fakeIdp(await exportJWK(publicKey), alg);
      await withFetch(idp.fetchImpl, async () => {
        const sign = (
          aud: string,
          expires = '5m',
          issuer = ISSUER,
          key = privateKey,
          sub: string | null = 'alice'
        ) => {
          let jwt = new SignJWT({})
          .setProtectedHeader({ alg, kid: 'test' })
          .setIssuer(issuer)
          .setAudience(aud)
          .setIssuedAt()
          .setExpirationTime(expires);
          if (sub !== null) jwt = jwt.setSubject(sub);
          return jwt.sign(key);
        };
        const verifier = createOidcTokenVerifier(config, idp.fetchImpl);
        await expect(verifier(await sign(config.oidcAudience))).resolves.toMatchObject({ sub: 'alice' });
        await expect(verifier(await sign('https://garmin.example.com/mcp'))).rejects.toMatchObject({ kind: 'unauthorized' });
        await expect(verifier(await sign(config.oidcAudience, '0s'))).rejects.toMatchObject({ kind: 'unauthorized' });
        await expect(verifier(await sign(config.oidcAudience, '5m', 'https://other.example.com/'))).rejects.toMatchObject({ kind: 'unauthorized' });
        await expect(verifier(await sign(config.oidcAudience, '5m', `${ISSUER}/`))).rejects.toMatchObject({ kind: 'unauthorized' });
        await expect(verifier(await sign(config.oidcAudience, '5m', ISSUER, foreignPrivateKey))).rejects.toMatchObject({ kind: 'unauthorized' });
        await expect(verifier(await sign(config.oidcAudience, '5m', ISSUER, privateKey, null))).rejects.toMatchObject({ kind: 'unauthorized' });
        // discovery is cached: fetched once for all the calls above
        expect(idp.calls.filter(u => u.endsWith('openid-configuration'))).toHaveLength(1);
      });
    });
  }

  it('rejects HS256 even when signed with a secret the attacker controls', async () => {
    const { publicKey } = await generateKeyPair('ES384');
    const idp = fakeIdp(await exportJWK(publicKey), 'ES384');
    await withFetch(idp.fetchImpl, async () => {
      const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256', kid: 'test' })
        .setIssuer(ISSUER).setAudience(config.oidcAudience).setSubject('alice')
        .setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode('x'.repeat(32)));
      await expect(createOidcTokenVerifier(config, idp.fetchImpl)(token)).rejects.toMatchObject({ kind: 'unauthorized' });
    });
  });

  it('fails closed as unavailable when discovery lies or is down, and retries next time', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES384');
    const jwk = await exportJWK(publicKey);
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'ES384', kid: 'test' })
      .setIssuer(ISSUER).setAudience(config.oidcAudience).setSubject('alice')
      .setIssuedAt().setExpirationTime('5m').sign(privateKey);

    const liar = fakeIdp(jwk, 'ES384', 'https://evil.example.com/oidc');
    await withFetch(liar.fetchImpl, async () => {
      await expect(createOidcTokenVerifier(config, liar.fetchImpl)(token)).rejects.toMatchObject({ kind: 'unavailable' });
    });

    const good = fakeIdp(jwk, 'ES384');
    let down = true;
    const flaky = vi.fn(async (input: string | URL | Request) => {
      if (down) throw new Error('ECONNREFUSED');
      return good.fetchImpl(input);
    }) as unknown as typeof fetch;
    await withFetch(good.fetchImpl, async () => {
      const verifier = createOidcTokenVerifier(config, flaky);
      await expect(verifier(token)).rejects.toMatchObject({ kind: 'unavailable' });
      down = false;
      await expect(verifier(token)).resolves.toMatchObject({ sub: 'alice' });
    });
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
