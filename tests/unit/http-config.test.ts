import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadHttpConfig } from '../../src/config/http.js';

const HTTP_ENV_VARS = [
  'WEATHER_API_KEYS', 'WEATHER_API_KEYS_FILE', 'WEATHER_API_KEYS_RELOAD_SECONDS', 'WEATHER_HTTP_HOST', 'WEATHER_HTTP_PORT', 'WEATHER_HTTP_PATH',
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
    process.env.WEATHER_API_KEYS = 'wx_test_key_aaaaaaaaaaaaaaaaaaaaaa';
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
    expect(config.apiKeysFile).toBeUndefined();
    expect(config.apiKeysReloadSeconds).toBe(10);
  });

  it('requires a key source', () => {
    delete process.env.WEATHER_API_KEYS;
    expect(() => loadHttpConfig()).toThrow(/WEATHER_API_KEYS_FILE/);

    process.env.WEATHER_API_KEYS = '   ';
    expect(() => loadHttpConfig()).toThrow(/WEATHER_API_KEYS_FILE/);
  });

  it('accepts a key file as the sole key source', () => {
    delete process.env.WEATHER_API_KEYS;
    process.env.WEATHER_API_KEYS_FILE = '/data/keys.json';

    const config = loadHttpConfig();
    expect(config.apiKeysFile).toBe('/data/keys.json');
  });

  it('allows key-file watching to be switched off', () => {
    process.env.WEATHER_API_KEYS_RELOAD_SECONDS = '0';
    expect(loadHttpConfig().apiKeysReloadSeconds).toBe(0);
  });

  it('normalizes the base path', () => {
    process.env.WEATHER_HTTP_PATH = '/weather/mcp/';
    expect(loadHttpConfig().basePath).toBe('/weather/mcp');
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
