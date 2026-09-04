/**
 * Per-tenant state for the HTTP transport.
 *
 * The stdio transport serves one person on one machine, so a single
 * `~/.weather-mcp/locations.json` is right. Over HTTP the same process answers
 * every authorized caller, and saved locations are personal data (home and work addresses):
 * each authorized tenant therefore gets its own store file under `WEATHER_DATA_DIR/<tenantId>/`.
 * Instances are cached because `LocationStore` keeps an in-memory copy that it
 * invalidates on write — two instances over one file would serve stale reads.
 */

import { join } from 'path';
import { LocationStore } from '../services/locationStore.js';

export class TenantRegistry {
  private readonly stores = new Map<string, LocationStore>();

  /**
   * @param dataDir Root directory holding one subdirectory per tenant id.
   */
  constructor(private readonly dataDir: string) {}

  /**
   * Get the saved-location store for a tenant, creating it on first use.
   *
   * @param tenantId Validated Garmin slug or explicit legacy alias.
   */
  getLocationStore(tenantId: string): LocationStore {
    const existing = this.stores.get(tenantId);
    if (existing) {
      return existing;
    }

    // disclosePath: false — the rendered output must not name a server directory.
    const store = new LocationStore(
      join(this.dataDir, tenantId, 'locations.json'),
      { disclosePath: false }
    );
    this.stores.set(tenantId, store);
    return store;
  }
}
