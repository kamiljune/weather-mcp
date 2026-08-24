/**
 * API key registry for the HTTP transport.
 *
 * The unit of identity is a **tenant** — a person or an installation — not a
 * key. A tenant owns one or more keys, so a key can be rotated or a second
 * client added without changing who the caller is, and therefore without
 * abandoning their saved locations. The tenant id is chosen by the operator and
 * names the caller's data directory, so it is validated strictly: it becomes a
 * path segment, and untrusted-looking input has no business being one.
 *
 * Keys arrive either in the URL path (`POST /mcp/<key>`) — the only mechanism
 * every remote-MCP client UI supports — or as `Authorization: Bearer <key>`.
 * Both are secrets, so the same rules the project already applies to key-in-URL
 * upstreams apply here in reverse: a presented key is never logged, never echoed
 * in an error, and never used as a filesystem path. Everything downstream
 * identifies a caller by the non-secret {@link ApiKeyRecord.id}.
 */

import { createHash } from 'crypto';
import { MIN_API_KEY_LENGTH } from '../config/http.js';

export interface ApiKeyRecord {
  /**
   * Stable, non-secret tenant identifier. Names the caller's saved-location
   * directory, so it survives key rotation — that is the whole point of it not
   * being derived from the key.
   */
  id: string;
  /** Human-readable name for logs. Defaults to the id. */
  label: string;
}

/** One tenant and the keys that authenticate as them. */
export interface TenantDefinition {
  id: string;
  label?: string;
  keys: string[];
}

/**
 * Tenant ids become directory names, so the character set is deliberately
 * narrow: lowercase alphanumerics, dash and underscore, starting with an
 * alphanumeric. No dots, no slashes, nothing that could climb a path.
 */
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Normalize and validate a tenant id.
 *
 * @throws Error when the id is empty or contains anything outside the pattern.
 */
export function normalizeTenantId(raw: unknown, context: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${context}: tenant id is required.`);
  }

  const id = raw.trim().toLowerCase();
  if (!TENANT_ID_PATTERN.test(id)) {
    throw new Error(
      `${context}: tenant id "${id}" is invalid. Use 1-64 characters of a-z, 0-9, ` +
      `dash or underscore, starting with a letter or digit.`
    );
  }
  return id;
}

/**
 * Fallback id for a key with no tenant name: a prefix of its own hash.
 *
 * Stable across restarts, but **not** across key rotation — a rotated key
 * becomes a different tenant and starts with empty saved locations. Callers
 * warn about this; naming the tenant is always better.
 */
export function derivedTenantId(key: string): string {
  return sha256Hex(key).slice(0, 12);
}

/**
 * An immutable snapshot of who may call and as whom.
 *
 * Lookup hashes the presented key and probes a Map, so no comparison ever runs
 * against the raw secret and no code path branches on how much of a key matched.
 */
export class ApiKeyRegistry {
  private readonly byHash = new Map<string, ApiKeyRecord>();
  private readonly byTenant = new Map<string, ApiKeyRecord>();

  /**
   * @param tenants Validated tenant definitions.
   * @throws Error when a tenant is malformed, an id repeats, a key is too
   *   short, or one key would authenticate as two different tenants.
   */
  constructor(tenants: TenantDefinition[]) {
    for (const tenant of tenants) {
      const id = normalizeTenantId(tenant.id, 'API keys');
      if (this.byTenant.has(id)) {
        throw new Error(`API keys: tenant id "${id}" is defined more than once.`);
      }

      const record: ApiKeyRecord = { id, label: tenant.label?.trim() || id };
      this.byTenant.set(id, record);

      if (!Array.isArray(tenant.keys) || tenant.keys.length === 0) {
        throw new Error(`API keys: tenant "${id}" has no keys.`);
      }

      for (const rawKey of tenant.keys) {
        if (typeof rawKey !== 'string') {
          throw new Error(`API keys: tenant "${id}" has a non-string key.`);
        }

        const key = rawKey.trim();
        if (key.length < MIN_API_KEY_LENGTH) {
          // Deliberately names the tenant, never the key.
          throw new Error(
            `API keys: a key for tenant "${id}" is shorter than ${MIN_API_KEY_LENGTH} ` +
            `characters. Generate one with: openssl rand -base64 32 | tr -d '=+/'`
          );
        }

        const hash = sha256Hex(key);
        const existing = this.byHash.get(hash);
        if (existing && existing.id !== id) {
          throw new Error(
            `API keys: the same key is assigned to both "${existing.id}" and "${id}".`
          );
        }
        this.byHash.set(hash, record);
      }
    }

    if (this.byTenant.size === 0) {
      throw new Error('API keys: no tenants were configured.');
    }
  }

  /** Number of distinct accepted keys. */
  get size(): number {
    return this.byHash.size;
  }

  /** Number of distinct tenants. */
  get tenantCount(): number {
    return this.byTenant.size;
  }

  /** Tenant ids — safe to log. */
  get tenantIds(): string[] {
    return [...this.byTenant.keys()];
  }

  /** Tenant labels — operator-chosen names, never key material. */
  get labels(): string[] {
    return [...this.byTenant.values()].map(record => record.label);
  }

  /**
   * Resolve a presented key to its tenant.
   *
   * @returns The record, or null when the key is absent, empty, or unknown.
   */
  verify(presented: string | undefined | null): ApiKeyRecord | null {
    if (typeof presented !== 'string' || presented === '') {
      return null;
    }
    return this.byHash.get(sha256Hex(presented)) ?? null;
  }

  /**
   * Whether another registry accepts exactly the same keys for the same
   * tenants. Used to keep a no-op file reload quiet.
   */
  equals(other: ApiKeyRegistry): boolean {
    if (this.byHash.size !== other.byHash.size) {
      return false;
    }

    for (const [hash, record] of this.byHash) {
      const theirs = other.byHash.get(hash);
      if (!theirs || theirs.id !== record.id || theirs.label !== record.label) {
        return false;
      }
    }
    return true;
  }
}

/**
 * Parse the `WEATHER_API_KEYS` environment form: comma-separated entries, each
 * `key` or `label:key`. The first colon separates the label, so labels must not
 * contain one.
 *
 * Entries sharing a label become one tenant with several keys — which is how a
 * person gets a Claude key and a ChatGPT key over the same saved locations.
 *
 * @param onWarning Called for each unlabelled key, whose tenant id is derived
 *   from the key and therefore does not survive rotation.
 */
export function parseKeySpec(spec: string, onWarning?: (message: string) => void): TenantDefinition[] {
  const byId = new Map<string, TenantDefinition>();

  for (const rawEntry of spec.split(',')) {
    const entry = rawEntry.trim();
    if (entry === '') {
      continue;
    }

    const separator = entry.indexOf(':');
    const rawLabel = separator === -1 ? '' : entry.slice(0, separator).trim();
    const key = separator === -1 ? entry : entry.slice(separator + 1).trim();

    let id: string;
    let label: string | undefined;
    if (rawLabel === '') {
      id = derivedTenantId(key);
      onWarning?.(
        `An unlabelled key was configured; its tenant id "${id}" is derived from the ` +
        `key, so rotating it starts a new empty saved-location namespace. ` +
        `Prefer "name:key".`
      );
    } else {
      id = normalizeTenantId(rawLabel, 'WEATHER_API_KEYS');
      label = rawLabel.trim();
    }

    const existing = byId.get(id);
    if (existing) {
      existing.keys.push(key);
    } else {
      byId.set(id, label === undefined ? { id, keys: [key] } : { id, label, keys: [key] });
    }
  }

  if (byId.size === 0) {
    throw new Error('WEATHER_API_KEYS contained no usable keys.');
  }

  return [...byId.values()];
}

/**
 * Parse the key-file form:
 *
 * ```json
 * { "tenants": [ { "id": "kamil", "label": "Kamil", "keys": ["...", "..."] } ] }
 * ```
 *
 * @throws Error describing the first structural problem found. Messages name
 *   tenants and positions, never key material.
 */
export function parseKeysDocument(raw: unknown): TenantDefinition[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Key file must be a JSON object with a "tenants" array.');
  }

  const tenants = (raw as { tenants?: unknown }).tenants;
  if (!Array.isArray(tenants)) {
    throw new Error('Key file must contain a "tenants" array.');
  }
  if (tenants.length === 0) {
    throw new Error('Key file "tenants" array is empty.');
  }

  return tenants.map((entry, index) => {
    const position = `Key file tenant #${index + 1}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${position} must be an object.`);
    }

    const { id: rawId, label, keys } = entry as Record<string, unknown>;
    const id = normalizeTenantId(rawId, position);

    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error(`${position} ("${id}") must have a non-empty "keys" array.`);
    }
    if (label !== undefined && typeof label !== 'string') {
      throw new Error(`${position} ("${id}") has a non-string "label".`);
    }

    return label === undefined
      ? { id, keys: keys as string[] }
      : { id, label, keys: keys as string[] };
  });
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
