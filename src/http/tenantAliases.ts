/** Legacy Weather tenant directory aliases keyed by Garmin slug. */

import { readFileSync } from 'fs';

const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class TenantAliases {
  private readonly aliases = new Map<string, string>();

  constructor(filePath?: string) {
    if (!filePath) return;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(filePath, 'utf8')); } catch (error) {
      throw new Error(`Tenant aliases file could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const entries = (raw as { slug_aliases?: unknown }).slug_aliases;
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
      throw new Error('Tenant aliases file must contain a "slug_aliases" object.');
    }
    for (const [slug, tenantId] of Object.entries(entries)) {
      if (!TENANT_ID.test(slug) || typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) {
        throw new Error(`Tenant alias ${JSON.stringify(slug)} has an invalid slug or tenant id.`);
      }
      this.aliases.set(slug, tenantId);
    }
  }

  resolve(slug: string): string {
    if (!TENANT_ID.test(slug)) throw new Error('Garmin returned an invalid user slug.');
    return this.aliases.get(slug) ?? slug;
  }
}

