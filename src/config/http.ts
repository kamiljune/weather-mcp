/**
 * Configuration for the Streamable HTTP transport (`src/http/index.ts`).
 *
 * Only read by the HTTP entry point — the stdio transport is unaffected by every
 * variable here. Parsing is strict and throws at startup: a service that is
 * reachable from the internet must not silently fall back to a weaker setting.
 */

import { homedir } from 'os';
import { join } from 'path';

/** Default listen port when WEATHER_HTTP_PORT is unset. */
const DEFAULT_PORT = 8080;

/** Default per-key request budget, in requests per minute. */
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

/** Default cap on a single JSON-RPC request body. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Lower bound on an API key, in characters. Shorter keys are refused at startup. */
export const MIN_API_KEY_LENGTH = 24;

export interface HttpConfig {
  /** Interface to bind. Defaults to 0.0.0.0 so a container publishes correctly. */
  host: string;
  /** TCP port to listen on. */
  port: number;
  /** Base path for the MCP endpoint, without a trailing slash (default "/mcp"). */
  basePath: string;
  /** Raw WEATHER_API_KEYS value; parsed by ApiKeyRegistry. */
  apiKeysSpec: string;
  /** Root directory for per-API-key saved-location stores. */
  dataDir: string;
  /** Per-key requests per minute; 0 disables rate limiting. */
  rateLimitPerMinute: number;
  /** Maximum accepted request body size in bytes. */
  maxBodyBytes: number;
  /** Host allowlist for DNS-rebinding protection; empty means the check is off. */
  allowedHosts: string[];
  /** Origin allowlist for DNS-rebinding protection; empty means the check is off. */
  allowedOrigins: string[];
  /**
   * Answer POSTs with a single `application/json` body instead of an SSE stream.
   * Both are valid Streamable HTTP; plain JSON survives buffering reverse proxies,
   * so it is the default. Set WEATHER_HTTP_JSON_RESPONSE=false for SSE.
   */
  jsonResponse: boolean;
  /** Expose the ChatGPT `search`/`fetch` compatibility tools. */
  chatgptCompat: boolean;
}

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`${name} must be "true" or "false" (got "${raw}")`);
}

function parseListEnv(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined) {
    return [];
  }
  return raw.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0);
}

function parseBasePath(raw: string | undefined): string {
  const value = (raw ?? '/mcp').trim();
  if (!value.startsWith('/')) {
    throw new Error(`WEATHER_HTTP_PATH must start with "/" (got "${value}")`);
  }
  // Strip trailing slashes so "/mcp/" and "/mcp" route identically.
  const trimmed = value.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Read and validate the HTTP configuration from the environment.
 *
 * @throws Error when a variable is malformed or WEATHER_API_KEYS is missing.
 */
export function loadHttpConfig(): HttpConfig {
  const apiKeysSpec = process.env.WEATHER_API_KEYS ?? '';
  if (apiKeysSpec.trim() === '') {
    throw new Error(
      'WEATHER_API_KEYS is required for the HTTP transport. Set it to one or more ' +
      'comma-separated keys, optionally labelled as "label:key".'
    );
  }

  return {
    host: process.env.WEATHER_HTTP_HOST?.trim() || '0.0.0.0',
    port: parseIntEnv('WEATHER_HTTP_PORT', DEFAULT_PORT, 1, 65535),
    basePath: parseBasePath(process.env.WEATHER_HTTP_PATH),
    apiKeysSpec,
    dataDir: process.env.WEATHER_DATA_DIR?.trim() || join(homedir(), '.weather-mcp', 'tenants'),
    rateLimitPerMinute: parseIntEnv('WEATHER_HTTP_RATE_LIMIT', DEFAULT_RATE_LIMIT_PER_MINUTE, 0, 100000),
    maxBodyBytes: parseIntEnv('WEATHER_HTTP_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, 1024, 32 * 1024 * 1024),
    allowedHosts: parseListEnv('WEATHER_HTTP_ALLOWED_HOSTS'),
    allowedOrigins: parseListEnv('WEATHER_HTTP_ALLOWED_ORIGINS'),
    jsonResponse: parseBoolEnv('WEATHER_HTTP_JSON_RESPONSE', true),
    chatgptCompat: parseBoolEnv('WEATHER_CHATGPT_COMPAT', false)
  };
}
