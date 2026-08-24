/**
 * The live set of accepted API keys, reloadable without a restart.
 *
 * Keys come from either `WEATHER_API_KEYS` (fixed for the process lifetime) or
 * `WEATHER_API_KEYS_FILE`, a JSON document that is re-read whenever it changes.
 * The file form exists so adding or revoking a person does not mean bouncing
 * the service on everyone else.
 *
 * The load-bearing rule is that **a bad reload never takes the service down**.
 * The registry is swapped only when a new document parses and validates
 * completely; a syntax error, a truncated write, or a deleted file leaves the
 * last good registry serving and logs the problem. Handing every caller a 401
 * because of a stray comma would be a far worse failure than running briefly on
 * stale keys.
 */

import { readFileSync, watchFile, unwatchFile } from 'fs';
import {
  ApiKeyRegistry,
  parseKeySpec,
  parseKeysDocument,
  type TenantDefinition
} from './apiKeys.js';
import { logger } from '../utils/logger.js';

export interface ApiKeySourceOptions {
  /** Path to the JSON key file. When set, it is the sole source of truth. */
  filePath?: string;
  /** `WEATHER_API_KEYS` value, used when no file is configured. */
  spec?: string;
  /** Seconds between file change checks. 0 disables watching. */
  pollSeconds: number;
}

export class ApiKeySource {
  private registry: ApiKeyRegistry;
  private watching = false;

  /**
   * Load the initial key set.
   *
   * @throws Error when the configured source is missing or invalid. Startup is
   *   the one time a bad key set must be fatal — coming up with no valid keys
   *   would reject every caller silently.
   */
  constructor(private readonly options: ApiKeySourceOptions) {
    this.registry = new ApiKeyRegistry(this.read());
  }

  /** The registry to authenticate against right now. */
  get current(): ApiKeyRegistry {
    return this.registry;
  }

  /** Whether keys can change without a restart. */
  get reloadable(): boolean {
    return this.options.filePath !== undefined;
  }

  /** The watched file path, for logging. */
  get filePath(): string | undefined {
    return this.options.filePath;
  }

  private read(): TenantDefinition[] {
    const { filePath, spec } = this.options;

    if (filePath !== undefined) {
      const contents = readFileSync(filePath, 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch (error) {
        throw new Error(`Key file is not valid JSON: ${(error as Error).message}`);
      }
      return parseKeysDocument(parsed);
    }

    if (spec === undefined || spec.trim() === '') {
      throw new Error('No API keys configured.');
    }

    return parseKeySpec(spec, message => logger.warn(message, { service: 'http' }));
  }

  /**
   * Re-read the source and swap the registry if it validates.
   *
   * Never throws: a failed reload is logged and the previous registry stays in
   * service.
   *
   * @returns true when the accepted keys actually changed.
   */
  reload(): boolean {
    let candidate: ApiKeyRegistry;
    try {
      candidate = new ApiKeyRegistry(this.read());
    } catch (error) {
      logger.error('API key reload failed; keeping the previous key set', error as Error, {
        service: 'http',
        securityEvent: true
      });
      return false;
    }

    if (this.registry.equals(candidate)) {
      return false;
    }

    const before = new Set(this.registry.tenantIds);
    const after = new Set(candidate.tenantIds);
    this.registry = candidate;

    logger.info('API keys reloaded', {
      service: 'http',
      tenants: candidate.tenantCount,
      keys: candidate.size,
      added: [...after].filter(id => !before.has(id)).join(', ') || 'none',
      removed: [...before].filter(id => !after.has(id)).join(', ') || 'none',
      securityEvent: true
    });
    return true;
  }

  /**
   * Begin watching the key file for changes.
   *
   * Uses mtime polling rather than inotify: the file is typically a Docker bind
   * mount, where filesystem events are unreliable, and a stat every few seconds
   * costs nothing.
   */
  startWatching(): void {
    const { filePath, pollSeconds } = this.options;
    if (this.watching || filePath === undefined || pollSeconds <= 0) {
      return;
    }

    watchFile(filePath, { interval: pollSeconds * 1000 }, (current, previous) => {
      // watchFile fires on every poll; only act on a real change. A deleted file
      // reports mtimeMs 0, which reload() turns into "keep the old set".
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
        this.reload();
      }
    });
    this.watching = true;
  }

  /** Stop watching. Safe to call when not watching. */
  stopWatching(): void {
    if (this.watching && this.options.filePath !== undefined) {
      unwatchFile(this.options.filePath);
      this.watching = false;
    }
  }
}
