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

/** Default per-tenant request budget, in requests per minute. */
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

/** Default cap on a single JSON-RPC request body. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Retained for the disconnected legacy key parser; HTTP runtime no longer uses API keys. */
export const MIN_API_KEY_LENGTH = 24;

export interface HttpConfig {
  /** Interface to bind. Defaults to 0.0.0.0 so a container publishes correctly. */
  host: string;
  /** TCP port to listen on. */
  port: number;
  /** Base path for the MCP endpoint, without a trailing slash (default "/mcp"). */
  basePath: string;
  /**
   * OIDC issuer URL, exactly as the IdP's discovery document states it
   * (Logto: https://auth.laputa.one/oidc, no trailing slash; Auth0: https://<tenant>/).
   * JWKS location and signing algorithm are read from the IdP, never hard-coded.
   */
  oidcIssuer: string;
  /** OAuth protected-resource identifier. Must equal the public MCP URL. */
  oidcAudience: string;
  /** Public origin used to publish RFC 9728 protected-resource metadata. */
  publicBaseUrl: string;
  /** Garmin's private, same-host entitlement endpoint. */
  garminAuthzUrl: string;
  /** Optional JSON file mapping Garmin slugs to legacy Weather tenant ids. */
  tenantAliasesFile?: string;
  /** Root directory for per-tenant saved-location stores. */
  dataDir: string;
  /** Per-tenant requests per minute; 0 disables rate limiting. */
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
 * @throws Error when a variable is malformed or OAuth configuration is missing.
 */
export function loadHttpConfig(): HttpConfig {
  // Renamed 2026-09-21 when the IdP moved from Auth0 to Logto. Fail loudly instead of
  // silently ignoring them, otherwise a half-migrated .env looks like "OAuth not configured".
  for (const legacy of ['WEATHER_AUTH0_DOMAIN', 'WEATHER_AUTH0_AUDIENCE']) {
    if (process.env[legacy]?.trim()) {
      throw new Error(
        `${legacy} is no longer read; use WEATHER_OIDC_ISSUER (full issuer URL) and WEATHER_OIDC_AUDIENCE.`
      );
    }
  }
  const oidcIssuer = process.env.WEATHER_OIDC_ISSUER?.trim() || '';
  const oidcAudience = process.env.WEATHER_OIDC_AUDIENCE?.trim() || '';
  const publicBaseUrl = (process.env.WEATHER_PUBLIC_BASE_URL?.trim() || '').replace(/\/+$/, '');
  const garminAuthzUrl = process.env.WEATHER_GARMIN_AUTHZ_URL?.trim() || '';

  for (const [name, value] of [
    ['WEATHER_OIDC_ISSUER', oidcIssuer],
    ['WEATHER_OIDC_AUDIENCE', oidcAudience],
    ['WEATHER_PUBLIC_BASE_URL', publicBaseUrl],
    ['WEATHER_GARMIN_AUTHZ_URL', garminAuthzUrl]
  ] as const) {
    if (value === '') throw new Error(`${name} is required; OAuth has no API-key fallback.`);
  }
  if (!oidcIssuer.startsWith('https://')) {
    throw new Error('WEATHER_OIDC_ISSUER must be the full https issuer URL, not a hostname.');
  }
  for (const [name, value] of [
    ['WEATHER_OIDC_ISSUER', oidcIssuer],
    ['WEATHER_OIDC_AUDIENCE', oidcAudience],
    ['WEATHER_PUBLIC_BASE_URL', publicBaseUrl],
    ['WEATHER_GARMIN_AUTHZ_URL', garminAuthzUrl]
  ] as const) {
    try { new URL(value); } catch { throw new Error(`${name} must be an absolute URL.`); }
  }

  const basePath = parseBasePath(process.env.WEATHER_HTTP_PATH);
  const resourceUrl = `${publicBaseUrl}${basePath}`;
  if (oidcAudience !== resourceUrl) {
    throw new Error(
      `WEATHER_OIDC_AUDIENCE must equal the public MCP resource URL "${resourceUrl}" ` +
      `(got "${oidcAudience}").`
    );
  }
  const tenantAliasesFile = process.env.WEATHER_TENANT_ALIASES_FILE?.trim() || undefined;

  return {
    host: process.env.WEATHER_HTTP_HOST?.trim() || '0.0.0.0',
    port: parseIntEnv('WEATHER_HTTP_PORT', DEFAULT_PORT, 1, 65535),
    basePath,
    oidcIssuer,
    oidcAudience,
    publicBaseUrl,
    garminAuthzUrl,
    ...(tenantAliasesFile === undefined ? {} : { tenantAliasesFile }),
    dataDir: process.env.WEATHER_DATA_DIR?.trim() || join(homedir(), '.weather-mcp', 'tenants'),
    rateLimitPerMinute: parseIntEnv('WEATHER_HTTP_RATE_LIMIT', DEFAULT_RATE_LIMIT_PER_MINUTE, 0, 100000),
    maxBodyBytes: parseIntEnv('WEATHER_HTTP_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, 1024, 32 * 1024 * 1024),
    allowedHosts: parseListEnv('WEATHER_HTTP_ALLOWED_HOSTS'),
    allowedOrigins: parseListEnv('WEATHER_HTTP_ALLOWED_ORIGINS'),
    jsonResponse: parseBoolEnv('WEATHER_HTTP_JSON_RESPONSE', true),
    chatgptCompat: parseBoolEnv('WEATHER_CHATGPT_COMPAT', false)
  };
}
