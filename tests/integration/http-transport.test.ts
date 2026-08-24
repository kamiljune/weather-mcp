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

const KEY_ALICE = 'wx_alice_key_aaaaaaaaaaaaaaaaaaaa';
const KEY_BOB = 'wx_bob_key_bbbbbbbbbbbbbbbbbbbbbb';

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream'
};

let createHttpServer: (config: HttpConfig) => {
  server: NodeHttpServer;
  apiKeys: { stopWatching(): void; reload(): boolean };
  rateLimiter: { stopSweeping(): void };
};
let dataDir: string;

function baseConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    basePath: '/mcp',
    apiKeysSpec: `alice:${KEY_ALICE},bob:${KEY_BOB}`,
    apiKeysReloadSeconds: 0,
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
  reloadKeys: () => boolean;
  stop: () => Promise<void>;
}> {
  const { server, apiKeys, rateLimiter } = createHttpServer(config);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    reloadKeys: () => apiKeys.reload(),
    stop: async () => {
      rateLimiter.stopSweeping();
      apiKeys.stopWatching();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}

function rpc(method: string, params?: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
}

async function callTool(url: string, name: string, args: Record<string, unknown>): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: MCP_HEADERS,
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

  it('rejects a request with no key', async () => {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list')
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    const payload = await response.json() as { error: { code: number; message: string } };
    expect(payload.error.code).toBe(-32001);
    // The failure must not hint at which keys exist.
    expect(payload.error.message).not.toContain(KEY_ALICE);
  });

  it('rejects an unknown key in the path', async () => {
    const response = await fetch(`${server.url}/mcp/wx_not_a_real_key_000000000000`, {
      method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list')
    });

    expect(response.status).toBe(401);
  });

  it('accepts a key in the URL path', async () => {
    const response = await fetch(`${server.url}/mcp/${KEY_ALICE}`, {
      method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list')
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as { result: { tools: Array<{ name: string }> } };
    expect(payload.result.tools.map(tool => tool.name)).toContain('get_forecast');
  });

  it('accepts a key in the Authorization header', async () => {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${KEY_ALICE}` },
      body: rpc('tools/list')
    });

    expect(response.status).toBe(200);
  });

  it('accepts a key in the query string', async () => {
    const response = await fetch(`${server.url}/mcp?key=${KEY_ALICE}`, {
      method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list')
    });

    expect(response.status).toBe(200);
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
    expect(payload.endpoint).toBe('/mcp/<api-key>');
  });

  it('404s an unrelated path', async () => {
    expect((await fetch(`${server.url}/admin`)).status).toBe(404);
    expect((await fetch(`${server.url}/mcp/${KEY_ALICE}/extra`)).status).toBe(404);
  });

  it('405s a GET on the stateless MCP endpoint', async () => {
    const response = await fetch(`${server.url}/mcp/${KEY_ALICE}`);

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('400s a body that is not JSON', async () => {
    const response = await fetch(`${server.url}/mcp/${KEY_ALICE}`, {
      method: 'POST', headers: MCP_HEADERS, body: 'not json at all'
    });

    expect(response.status).toBe(400);
    const payload = await response.json() as { error: { code: number } };
    expect(payload.error.code).toBe(-32700);
  });

  it('413s a body over the cap', async () => {
    const response = await fetch(`${server.url}/mcp/${KEY_ALICE}`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: rpc('tools/call', { name: 'search_location', arguments: { query: 'x'.repeat(8192) } })
    });

    expect(response.status).toBe(413);
  });

  it('answers tools/list without a prior initialize (stateless)', async () => {
    const response = await fetch(`${server.url}/mcp/${KEY_ALICE}`, {
      method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list', undefined, 7)
    });

    const payload = await response.json() as { id: number; result: { tools: unknown[] } };
    expect(payload.id).toBe(7);
    expect(payload.result.tools.length).toBeGreaterThan(0);
  });
});

describe('HTTP transport — per-key isolation', () => {
  let server: { url: string; stop: () => Promise<void> };

  beforeAll(async () => { server = await startServer(baseConfig()); });
  afterAll(async () => { await server.stop(); });

  it('keeps saved locations private to the key that saved them', async () => {
    const aliceUrl = `${server.url}/mcp/${KEY_ALICE}`;
    const bobUrl = `${server.url}/mcp/${KEY_BOB}`;

    await callTool(aliceUrl, 'save_location', {
      alias: 'home', latitude: 47.6062, longitude: -122.3321, name: 'Seattle, WA'
    });

    expect(await callTool(aliceUrl, 'list_saved_locations', {})).toContain('home');
    expect(await callTool(bobUrl, 'list_saved_locations', {})).toContain('No saved locations yet');
  });

  it('never discloses the server-side store path', async () => {
    const listing = await callTool(`${server.url}/mcp/${KEY_ALICE}`, 'list_saved_locations', {});

    expect(listing).not.toContain('Storage location');
    expect(listing).not.toContain(dataDir);
  });
});

describe('HTTP transport — key file hot reload', () => {
  let keyFile: string;
  let server: { url: string; reloadKeys: () => boolean; stop: () => Promise<void> };

  const NEW_KEY = 'wx_carol_key_cccccccccccccccccccc';
  const ROTATED_ALICE_KEY = 'wx_alice_rotated_kkkkkkkkkkkkkkkkkk';

  function writeKeys(tenants: unknown): void {
    writeFileSync(keyFile, JSON.stringify({ tenants }), 'utf-8');
  }

  async function statusFor(key: string): Promise<number> {
    const response = await fetch(`${server.url}/mcp/${key}`, {
      method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list')
    });
    await response.arrayBuffer();
    return response.status;
  }

  beforeAll(async () => {
    keyFile = join(dataDir, 'keys.json');
    writeKeys([{ id: 'alice', keys: [KEY_ALICE] }]);
    // pollSeconds 0: the test drives reload() directly so it stays deterministic.
    server = await startServer(baseConfig({ apiKeysFile: keyFile, apiKeysReloadSeconds: 0 }));
  });

  afterAll(async () => { await server.stop(); });

  it('admits a tenant added to the file, with no restart', async () => {
    expect(await statusFor(NEW_KEY)).toBe(401);

    writeKeys([{ id: 'alice', keys: [KEY_ALICE] }, { id: 'carol', keys: [NEW_KEY] }]);
    expect(server.reloadKeys()).toBe(true);

    expect(await statusFor(NEW_KEY)).toBe(200);
    expect(await statusFor(KEY_ALICE)).toBe(200);
  });

  it('revokes a tenant removed from the file', async () => {
    writeKeys([{ id: 'alice', keys: [KEY_ALICE] }]);
    expect(server.reloadKeys()).toBe(true);

    expect(await statusFor(NEW_KEY)).toBe(401);
  });

  it('keeps saved locations across a key rotation', async () => {
    const before = await callTool(`${server.url}/mcp/${KEY_ALICE}`, 'save_location', {
      alias: 'cabin', latitude: 39.0968, longitude: -120.0324, name: 'Lake Tahoe, CA'
    });
    expect(before).toContain('cabin');

    // Same tenant id, different key — the identity, and therefore the data, survives.
    writeKeys([{ id: 'alice', keys: [ROTATED_ALICE_KEY] }]);
    expect(server.reloadKeys()).toBe(true);

    expect(await statusFor(KEY_ALICE)).toBe(401);
    const listing = await callTool(`${server.url}/mcp/${ROTATED_ALICE_KEY}`, 'list_saved_locations', {});
    expect(listing).toContain('cabin');
  });

  it('names the storage directory by tenant id, not by key', () => {
    expect(existsSync(join(dataDir, 'alice', 'locations.json'))).toBe(true);
  });

  it('keeps serving the last good key set when the file breaks', async () => {
    writeFileSync(keyFile, '{ "tenants": [', 'utf-8');

    expect(server.reloadKeys()).toBe(false);
    expect(await statusFor(ROTATED_ALICE_KEY)).toBe(200);
  });
});

describe('HTTP transport — rate limiting', () => {
  let server: { url: string; stop: () => Promise<void> };

  beforeAll(async () => { server = await startServer(baseConfig({ rateLimitPerMinute: 3 })); });
  afterAll(async () => { await server.stop(); });

  it('429s past the budget and meters keys independently', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await fetch(`${server.url}/mcp/${KEY_ALICE}`, {
        method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list')
      });
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get('retry-after')).toBeTruthy();
      }
      await response.arrayBuffer();
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);

    const bob = await fetch(`${server.url}/mcp/${KEY_BOB}`, {
      method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list')
    });
    expect(bob.status).toBe(200);
  });
});

describe('HTTP transport — ChatGPT compatibility toggle', () => {
  it('hides search/fetch by default', async () => {
    const server = await startServer(baseConfig());
    try {
      const response = await fetch(`${server.url}/mcp/${KEY_ALICE}`, {
        method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list')
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
      const response = await fetch(`${server.url}/mcp/${KEY_ALICE}`, {
        method: 'POST', headers: MCP_HEADERS, body: rpc('tools/list')
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
