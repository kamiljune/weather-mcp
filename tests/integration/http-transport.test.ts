/**
 * End-to-end tests for the Streamable HTTP transport.
 *
 * Binds an ephemeral loopback port and drives it with real HTTP requests. Only
 * tools that need no upstream call are exercised (tools/list and the saved
 * location tools), so the suite never touches the network.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as NodeHttpServer } from 'http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HttpConfig } from '../../src/config/http.js';
import { AuthFailure, type WeatherAuthorizer } from '../../src/http/oauth.js';

const TOKEN_ALICE = 'oauth-token-alice';
const TOKEN_BOB = 'oauth-token-bob';
const TOKEN_USER4 = 'oauth-token-user4';

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream'
};

let createHttpServer: (config: HttpConfig, overrides?: { authorizer?: WeatherAuthorizer }) => {
  server: NodeHttpServer;
  rateLimiter: { stopSweeping(): void };
};
let dataDir: string;

function baseConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    basePath: '/mcp',
    auth0Domain: 'example.auth0.com',
    auth0Audience: 'https://weather.example.com/mcp',
    publicBaseUrl: 'https://weather.example.com',
    garminAuthzUrl: 'http://garmin-api:8412/internal/weather/identity',
    dataDir,
    rateLimitPerMinute: 0,
    maxBodyBytes: 1024 * 1024,
    allowedHosts: [],
    allowedOrigins: [],
    jsonResponse: true,
    chatgptCompat: false,
    ...overrides
  };
}

/** Start a server on an ephemeral port and return its base URL plus a stopper. */
async function startServer(config: HttpConfig): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const authorizer: WeatherAuthorizer = {
    async authorize(token) {
      if (token === TOKEN_ALICE) return { slug: 'alice' };
      if (token === TOKEN_BOB) return { slug: 'bob' };
      if (token === TOKEN_USER4) return { slug: 'user4' };
      if (token === 'forbidden') throw new AuthFailure('forbidden', 'not allowed');
      if (token === 'unavailable') throw new AuthFailure('unavailable', 'unavailable');
      throw new AuthFailure('unauthorized', 'invalid token');
    }
  };
  const { server, rateLimiter } = createHttpServer(config, { authorizer });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      rateLimiter.stopSweeping();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}

function rpc(method: string, params?: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
}

async function callTool(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
    body: rpc('tools/call', { name, arguments: args })
  });
  const payload = await response.json() as { result?: { content?: Array<{ text: string }> } };
  return payload.result?.content?.[0]?.text ?? '';
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'weather-mcp-http-'));
  // The saved-location tools are outside the default preset, and toolConfig reads
  // the environment at import time — so set it before the module graph loads.
  process.env.ENABLED_TOOLS = 'all';
  process.env.WEATHER_LIGHTNING_PREWARM = 'false';
  ({ createHttpServer } = await import('../../src/http/httpServer.js'));
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('HTTP transport — authentication', () => {
  let server: { url: string; stop: () => Promise<void> };

  beforeAll(async () => { server = await startServer(baseConfig()); });
  afterAll(async () => { await server.stop(); });

  it('rejects a request with no OAuth token and advertises resource metadata', async () => {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list')
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    const payload = await response.json() as { error: { code: number; message: string } };
    expect(payload.error.code).toBe(-32001);
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://weather.example.com/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it('removes the URL-key route', async () => {
    const response = await fetch(`${server.url}/mcp/old-static-key`, {
      method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list')
    });

    expect(response.status).toBe(404);
  });

  it('does not treat query keys or static bearer values as credentials', async () => {
    const query = await fetch(`${server.url}/mcp?key=old-static-key`, {
      method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list')
    });
    expect(query.status).toBe(401);

    const bearer = await fetch(`${server.url}/mcp`, {
      method: 'POST', headers: { ...MCP_HEADERS, Authorization: 'Bearer old-static-key' },
      body: rpc('tools/list')
    });
    expect(bearer.status).toBe(401);
  });

  it('accepts an authorized OAuth token', async () => {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN_ALICE}` },
      body: rpc('tools/list')
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as { result: { tools: Array<{ name: string }> } };
    expect(payload.result.tools.map(tool => tool.name)).toContain('get_forecast');
  });

  it('distinguishes denied users from an unavailable authorization service', async () => {
    const status = async (token: string) => (await fetch(`${server.url}/mcp`, {
      method: 'POST', headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
      body: rpc('tools/list')
    })).status;
    expect(await status('forbidden')).toBe(403);
    expect(await status('unavailable')).toBe(503);
  });
});

describe('HTTP transport — routing and request hygiene', () => {
  let server: { url: string; stop: () => Promise<void> };

  beforeAll(async () => { server = await startServer(baseConfig({ maxBodyBytes: 2048 })); });
  afterAll(async () => { await server.stop(); });

  it('serves an unauthenticated health check', async () => {
    const response = await fetch(`${server.url}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', server: 'weather-mcp' });
  });

  it('describes the endpoint at the root without naming a key', async () => {
    const response = await fetch(`${server.url}/`);
    const payload = await response.json() as { endpoint: string };

    expect(response.status).toBe(200);
    expect(payload.endpoint).toBe('/mcp');
  });

  it('publishes RFC 9728 protected-resource metadata', async () => {
    const response = await fetch(
      `${server.url}/.well-known/oauth-protected-resource/mcp`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: 'https://weather.example.com/mcp',
      authorization_servers: ['https://example.auth0.com/'],
      bearer_methods_supported: ['header'],
      resource_name: 'Weather MCP'
    });
  });

  it('404s an unrelated path', async () => {
    expect((await fetch(`${server.url}/admin`)).status).toBe(404);
    expect((await fetch(`${server.url}/mcp/extra`)).status).toBe(404);
  });

  it('405s a GET on the stateless MCP endpoint', async () => {
    const response = await fetch(`${server.url}/mcp`);

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('400s a body that is not JSON', async () => {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST', headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN_ALICE}` },
      body: 'not json at all'
    });

    expect(response.status).toBe(400);
    const payload = await response.json() as { error: { code: number } };
    expect(payload.error.code).toBe(-32700);
  });

  it('413s a body over the cap', async () => {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN_ALICE}` },
      body: rpc('tools/call', { name: 'search_location', arguments: { query: 'x'.repeat(8192) } })
    });

    expect(response.status).toBe(413);
  });

  it('answers tools/list without a prior initialize (stateless)', async () => {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST', headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN_ALICE}` },
      body: rpc('tools/list', undefined, 7)
    });

    const payload = await response.json() as { id: number; result: { tools: unknown[] } };
    expect(payload.id).toBe(7);
    expect(payload.result.tools.length).toBeGreaterThan(0);
  });
});

describe('HTTP transport — per-tenant isolation', () => {
  let server: { url: string; stop: () => Promise<void> };

  beforeAll(async () => { server = await startServer(baseConfig()); });
  afterAll(async () => { await server.stop(); });

  it('keeps saved locations private to the authorized tenant', async () => {
    const mcpUrl = `${server.url}/mcp`;

    await callTool(mcpUrl, TOKEN_ALICE, 'save_location', {
      alias: 'home', latitude: 47.6062, longitude: -122.3321, name: 'Seattle, WA'
    });

    expect(await callTool(mcpUrl, TOKEN_ALICE, 'list_saved_locations', {})).toContain('home');
    expect(await callTool(mcpUrl, TOKEN_BOB, 'list_saved_locations', {})).toContain('No saved locations yet');
  });

  it('never discloses the server-side store path', async () => {
    const listing = await callTool(`${server.url}/mcp`, TOKEN_ALICE, 'list_saved_locations', {});

    expect(listing).not.toContain('Storage location');
    expect(listing).not.toContain(dataDir);
  });
  it('maps Garmin user4 to the legacy lihao namespace', async () => {
    const aliases = join(dataDir, 'tenant-aliases.json');
    writeFileSync(aliases, JSON.stringify({ slug_aliases: { user4: 'lihao' } }));
    const mapped = await startServer(baseConfig({ tenantAliasesFile: aliases }));
    try {
      await callTool(`${mapped.url}/mcp`, TOKEN_USER4, 'save_location', {
        alias: 'office', latitude: 31.23, longitude: 121.47, name: 'Shanghai'
      });
      expect(existsSync(join(dataDir, 'lihao', 'locations.json'))).toBe(true);
      expect(existsSync(join(dataDir, 'user4', 'locations.json'))).toBe(false);
    } finally {
      await mapped.stop();
    }
  });
});

describe('HTTP transport — rate limiting', () => {
  let server: { url: string; stop: () => Promise<void> };

  beforeAll(async () => { server = await startServer(baseConfig({ rateLimitPerMinute: 3 })); });
  afterAll(async () => { await server.stop(); });

  it('429s past the budget and meters keys independently', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await fetch(`${server.url}/mcp`, {
        method: 'POST', headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN_ALICE}` },
        body: rpc('tools/list')
      });
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get('retry-after')).toBeTruthy();
      }
      await response.arrayBuffer();
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);

    const bob = await fetch(`${server.url}/mcp`, {
      method: 'POST', headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN_BOB}` },
      body: rpc('tools/list')
    });
    expect(bob.status).toBe(200);
  });
});

describe('HTTP transport — ChatGPT compatibility toggle', () => {
  it('hides search/fetch by default', async () => {
    const server = await startServer(baseConfig());
    try {
      const response = await fetch(`${server.url}/mcp`, {
        method: 'POST', headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN_ALICE}` },
        body: rpc('tools/list')
      });
      const names = ((await response.json()) as { result: { tools: Array<{ name: string }> } })
        .result.tools.map(tool => tool.name);

      expect(names).not.toContain('search');
      expect(names).not.toContain('fetch');
    } finally {
      await server.stop();
    }
  });

  it('adds search/fetch when enabled, leaving the native tools in place', async () => {
    const server = await startServer(baseConfig({ chatgptCompat: true }));
    try {
      const response = await fetch(`${server.url}/mcp`, {
        method: 'POST', headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN_ALICE}` },
        body: rpc('tools/list')
      });
      const names = ((await response.json()) as { result: { tools: Array<{ name: string }> } })
        .result.tools.map(tool => tool.name);

      expect(names).toContain('search');
      expect(names).toContain('fetch');
      expect(names).toContain('get_weather_summary');
    } finally {
      await server.stop();
    }
  });
});
