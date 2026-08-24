/**
 * API key registry for the HTTP transport.
 *
 * Keys arrive either in the URL path (`POST /mcp/<key>`) — the only mechanism
 * every remote-MCP client UI supports — or as `Authorization: Bearer <key>`.
 * Both are secrets, so the same rules the project already applies to key-in-URL
 * upstreams apply here in reverse: a presented key is never logged, never echoed
 * in an error, and never used as a filesystem path. Everything downstream
 * identifies a caller by the derived, non-secret {@link ApiKeyRecord.id}.
 */

import { createHash } from 'crypto';
import { MIN_API_KEY_LENGTH } from '../config/http.js';

export interface ApiKeyRecord {
  /**
   * Stable, non-secret identifier: the first 12 hex characters of the key's
   * SHA-256. Safe to log and to use as a directory name. Deterministic across
   * restarts so a caller keeps its saved locations.
   */
  id: string;
  /** Operator-supplied label from `label:key`, or the id when unlabelled. */
  label: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Parsed set of accepted API keys.
 *
 * Lookup hashes the presented key and probes a Map, so no comparison ever runs
 * against the raw secret and no code path branches on how much of a key matched.
 */
export class ApiKeyRegistry {
  private readonly byHash = new Map<string, ApiKeyRecord>();

  /**
   * @param spec Comma-separated entries, each `key` or `label:key`. The first
   *   colon separates the label, so labels must not contain one.
   * @throws Error when the spec contains no usable key or a key is too short.
   */
  constructor(spec: string) {
    for (const rawEntry of spec.split(',')) {
      const entry = rawEntry.trim();
      if (entry === '') {
        continue;
      }

      const separator = entry.indexOf(':');
      const label = separator === -1 ? '' : entry.slice(0, separator).trim();
      const key = separator === -1 ? entry : entry.slice(separator + 1).trim();

      if (key.length < MIN_API_KEY_LENGTH) {
        // Deliberately reports the label (or position) rather than the key.
        throw new Error(
          `API key ${label ? `"${label}"` : `#${this.byHash.size + 1}`} is shorter than ` +
          `${MIN_API_KEY_LENGTH} characters. Generate one with: openssl rand -base64 32 | tr -d '=+/'`
        );
      }

      const hash = sha256Hex(key);
      this.byHash.set(hash, { id: hash.slice(0, 12), label: label || hash.slice(0, 12) });
    }

    if (this.byHash.size === 0) {
      throw new Error('WEATHER_API_KEYS contained no usable keys.');
    }
  }

  /** Number of distinct accepted keys. */
  get size(): number {
    return this.byHash.size;
  }

  /** Labels of the configured keys — safe to log at startup. */
  get labels(): string[] {
    return [...this.byHash.values()].map(record => record.label);
  }

  /**
   * Resolve a presented key to its record.
   *
   * @returns The record, or null when the key is absent, empty, or unknown.
   */
  verify(presented: string | undefined | null): ApiKeyRecord | null {
    if (typeof presented !== 'string' || presented === '') {
      return null;
    }
    return this.byHash.get(sha256Hex(presented)) ?? null;
  }
}

/**
 * Extract the bearer token from an Authorization header value.
 *
 * @returns The token, or null when the header is missing or not a bearer scheme.
 */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}
