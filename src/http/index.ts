#!/usr/bin/env node

/**
 * Weather MCP Server — Streamable HTTP entry point.
 *
 * Serves the same tools as the stdio entry point over HTTP so that hosted
 * assistants (Claude custom connectors, ChatGPT connectors) can reach it at a
 * public URL. Start with `npm run start:http`, or `node dist/http/index.js`.
 */

import 'dotenv/config';

import { loadHttpConfig } from '../config/http.js';
import { createHttpServer } from './httpServer.js';
import { CacheConfig } from '../config/cache.js';
import { toolConfig } from '../config/tools.js';
import { logger } from '../utils/logger.js';
import { analytics } from '../analytics/index.js';
import { noaaService, openMeteoService, SERVER_VERSION } from '../server/weatherServer.js';

/** How long to let in-flight requests finish before forcing exit. */
const SHUTDOWN_GRACE_MS = 10000;

function main(): void {
  const config = loadHttpConfig();
  const { server, rateLimiter } = createHttpServer(config);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);

    const forceExit = setTimeout(() => {
      logger.warn('Shutdown grace period elapsed, exiting');
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    try {
      await new Promise<void>(resolve => server.close(() => resolve()));
      logger.info('HTTP listener closed');

      rateLimiter.stopSweeping();
      await analytics.shutdown();
      noaaService.clearCache();
      openMeteoService.clearCache();
      logger.info('Caches cleared');

      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', error as Error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  server.listen(config.port, config.host, () => {
    logger.info('Weather MCP HTTP server listening', {
      version: SERVER_VERSION,
      host: config.host,
      port: config.port,
      endpoint: config.basePath,
      auth: 'OIDC OAuth + Garmin user allowlist',
      audience: config.oidcAudience,
      authorizationServer: config.oidcIssuer,
      garminAuthzUrl: config.garminAuthzUrl,
      tenantAliasesFile: config.tenantAliasesFile ?? 'none',
      rateLimitPerMinute: config.rateLimitPerMinute,
      jsonResponse: config.jsonResponse,
      chatgptCompat: config.chatgptCompat,
      dnsRebindingProtection: config.allowedHosts.length > 0 || config.allowedOrigins.length > 0,
      cacheEnabled: CacheConfig.enabled,
      enabledTools: toolConfig.getEnabledTools().length
    });
  });
}

try {
  main();
} catch (error) {
  // Configuration errors must be loud: the process should not come up half-configured.
  logger.error('Failed to start HTTP server', error as Error);
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'FATAL',
    message: 'Application failed to start',
    error: { message: error instanceof Error ? error.message : String(error) }
  }));
  process.exit(1);
}
