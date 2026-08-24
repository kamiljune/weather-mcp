/**
 * Per-API-key state for the HTTP transport.
 *
 * The stdio transport serves one person on one machine, so a single
 * `~/.weather-mcp/locations.json` is right. Over HTTP the same process answers
 * every key, and saved locations are personal data (home and work addresses):
 * each key therefore gets its own store file under `WEATHER_DATA_DIR/<keyId>/`.
 * Instances are cached because `LocationStore` keeps an in-memory copy that it
 * invalidates on write — two instances over one file would serve stale reads.
 */

import { join } from 'path';
import { LocationStore } from '../services/locationStore.js';

export class TenantRegistry {
  private readonly stores = new Map<string, LocationStore>();

  /**
   * @param dataDir Root directory holding one subdirectory per API key id.
   */
  constructor(private readonly dataDir: string) {}

  /**
   * Get the saved-location store for an API key, creating it on first use.
   *
   * @param keyId Non-secret key identifier from {@link ApiKeyRecord.id}. Callers
   *   must never pass a raw key — it would end up in a path and in logs.
   */
  getLocationStore(keyId: string): LocationStore {
    const existing = this.stores.get(keyId);
    if (existing) {
      return existing;
    }

    // disclosePath: false — the rendered output must not name a server directory.
    const store = new LocationStore(
      join(this.dataDir, keyId, 'locations.json'),
      { disclosePath: false }
    );
    this.stores.set(keyId, store);
    return store;
  }
}
