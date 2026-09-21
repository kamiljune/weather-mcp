import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadHttpConfig } from '../../src/config/http.js';

const HTTP_ENV_VARS = [
  'WEATHER_OIDC_ISSUER', 'WEATHER_OIDC_AUDIENCE', 'WEATHER_AUTH0_DOMAIN', 'WEATHER_AUTH0_AUDIENCE', 'WEATHER_PUBLIC_BASE_URL',
  'WEATHER_GARMIN_AUTHZ_URL', 'WEATHER_TENANT_ALIASES_FILE',
  'WEATHER_HTTP_HOST', 'WEATHER_HTTP_PORT', 'WEATHER_HTTP_PATH',
  'WEATHER_DATA_DIR', 'WEATHER_HTTP_RATE_LIMIT', 'WEATHER_HTTP_MAX_BODY_BYTES',
  'WEATHER_HTTP_ALLOWED_HOSTS', 'WEATHER_HTTP_ALLOWED_ORIGINS',
  'WEATHER_HTTP_JSON_RESPONSE', 'WEATHER_CHATGPT_COMPAT'
];

describe('loadHttpConfig', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(HTTP_ENV_VARS.map(name => [name, process.env[name]]));
    for (const name of HTTP_ENV_VARS) {
      delete process.env[name];
    }
    process.env.WEATHER_OIDC_ISSUER = 'https://auth.example.com/oidc';
    process.env.WEATHER_OIDC_AUDIENCE = 'https://weather.example.com/mcp';
    process.env.WEATHER_PUBLIC_BASE_URL = 'https://weather.example.com';
    process.env.WEATHER_GARMIN_AUTHZ_URL = 'http://garmin-api:8412/internal/weather/identity';
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('applies safe defaults', () => {
    const config = loadHttpConfig();

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.basePath).toBe('/mcp');
    expect(config.rateLimitPerMinute).toBe(120);
    expect(config.jsonResponse).toBe(true);
    // ChatGPT compatibility tools are opt-in so the default tool list is unchanged.
    expect(config.chatgptCompat).toBe(false);
    expect(config.allowedHosts).toEqual([]);
    expect(config.oidcIssuer).toBe('https://auth.example.com/oidc');
    expect(config.oidcAudience).toBe('https://weather.example.com/mcp');
    expect(config.tenantAliasesFile).toBeUndefined();
  });

  it('requires the complete OAuth and Garmin authorization configuration', () => {
    for (const name of [
      'WEATHER_OIDC_ISSUER', 'WEATHER_OIDC_AUDIENCE',
      'WEATHER_PUBLIC_BASE_URL', 'WEATHER_GARMIN_AUTHZ_URL'
    ]) {
      const value = process.env[name];
      delete process.env[name];
      expect(() => loadHttpConfig()).toThrow(new RegExp(name));
      process.env[name] = value;
    }
  });

  it('normalizes the base path', () => {
    process.env.WEATHER_HTTP_PATH = '/weather/mcp/';
    process.env.WEATHER_OIDC_AUDIENCE = 'https://weather.example.com/weather/mcp';
    expect(loadHttpConfig().basePath).toBe('/weather/mcp');
  });

  it('requires the OAuth audience to equal the public MCP URL exactly', () => {
    process.env.WEATHER_OIDC_AUDIENCE = 'https://weather.example.com/mcp/';
    expect(() => loadHttpConfig()).toThrow(/must equal the public MCP resource URL/);
  });

  it('rejects a bare hostname as issuer', () => {
    process.env.WEATHER_OIDC_ISSUER = 'auth.example.com';
    expect(() => loadHttpConfig()).toThrow(/full https issuer URL/);
  });

  it('refuses the renamed Auth0 variables instead of ignoring them', () => {
    for (const legacy of ['WEATHER_AUTH0_DOMAIN', 'WEATHER_AUTH0_AUDIENCE']) {
      process.env[legacy] = 'x';
      expect(() => loadHttpConfig()).toThrow(new RegExp(`${legacy} is no longer read`));
      delete process.env[legacy];
    }
  });

  it('rejects a base path without a leading slash', () => {
    process.env.WEATHER_HTTP_PATH = 'mcp';
    expect(() => loadHttpConfig()).toThrow(/must start with/);
  });

  it('rejects a malformed port rather than falling back', () => {
    process.env.WEATHER_HTTP_PORT = '99999';
    expect(() => loadHttpConfig()).toThrow(/WEATHER_HTTP_PORT/);

    process.env.WEATHER_HTTP_PORT = 'eighty';
    expect(() => loadHttpConfig()).toThrow(/WEATHER_HTTP_PORT/);
  });

  it('rejects a non-boolean flag rather than reading it as false', () => {
    process.env.WEATHER_CHATGPT_COMPAT = 'yes';
    expect(() => loadHttpConfig()).toThrow(/WEATHER_CHATGPT_COMPAT/);
  });

  it('parses list variables and enables the flags they gate', () => {
    process.env.WEATHER_HTTP_ALLOWED_HOSTS = 'weather.example.com, localhost:8080 ,';
    process.env.WEATHER_CHATGPT_COMPAT = 'true';
    process.env.WEATHER_HTTP_JSON_RESPONSE = 'false';

    const config = loadHttpConfig();
    expect(config.allowedHosts).toEqual(['weather.example.com', 'localhost:8080']);
    expect(config.chatgptCompat).toBe(true);
    expect(config.jsonResponse).toBe(false);
  });

  it('allows rate limiting to be switched off explicitly', () => {
    process.env.WEATHER_HTTP_RATE_LIMIT = '0';
    expect(loadHttpConfig().rateLimitPerMinute).toBe(0);
  });
});
