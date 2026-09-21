/**
 * Streamable HTTP transport for the weather MCP server.
 *
 * Runs stateless: every POST builds a fresh `Server` + transport pair, answers
 * the JSON-RPC request, and tears both down. No session ids, no server-held
 * conversation state — so restarts and multiple replicas are invisible to
 * clients, and nothing survives a request except the shared upstream caches.
 *
 * Routing:
 *   POST   /mcp         MCP endpoint, OIDC access token in Authorization header
 *   GET    /.well-known/oauth-protected-resource/mcp  OAuth resource metadata
 *   GET    /healthz     liveness probe
 *   GET    /            endpoint discovery
 */

import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { HttpConfig } from '../config/http.js';
import { AuthFailure, bearerToken, GarminBackedAuthorizer, type WeatherAuthorizer } from './oauth.js';
import { RateLimiter } from './rateLimit.js';
import { TenantRegistry } from './tenants.js';
import { TenantAliases } from './tenantAliases.js';
import { createWeatherServer, SERVER_NAME, SERVER_VERSION } from '../server/weatherServer.js';
import { logger } from '../utils/logger.js';

/** JSON-RPC error codes used by the transport layer. */
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_UNAUTHORIZED = -32001;
const JSONRPC_FORBIDDEN = -32003;
const JSONRPC_UNAVAILABLE = -32004;

/**
 * Send a JSON-RPC error response with an HTTP status.
 *
 * `id` is null because these failures happen before (or instead of) parsing a
 * request id — that is what the JSON-RPC spec prescribes for such cases.
 */
function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {}
): void {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/**
 * Read the request body, refusing anything over the configured cap.
 *
 * @returns The raw body, or null when the cap was exceeded (the response is
 *   already written in that case).
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;

    req.on('data', (chunk: Buffer) => {
      if (exceeded) {
        return;
      }

      size += chunk.length;
      if (size > maxBytes) {
        exceeded = true;
        // Pause rather than destroy: destroying here kills the socket before the
        // 413 can be written, and the client sees a connection reset instead of
        // an answer. The caller closes the connection once the response is out.
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!exceeded) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', reject);
  });
}

export interface HttpServerDeps {
  config: HttpConfig;
  authorizer: WeatherAuthorizer;
  aliases: TenantAliases;
  tenants: TenantRegistry;
  rateLimiter: RateLimiter;
}

/**
 * Build the request listener. Exported separately from {@link createHttpServer}
 * so tests can drive it without binding a port.
 */
export function createRequestListener(deps: HttpServerDeps) {
  const { config, authorizer, aliases, tenants, rateLimiter } = deps;
  const metadataPath = `/.well-known/oauth-protected-resource${config.basePath}`;
  const metadataUrl = `${config.publicBaseUrl}${metadataPath}`;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    if (url.pathname === '/healthz') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      sendJson(res, 200, { status: 'ok', server: SERVER_NAME, version: SERVER_VERSION });
      return;
    }

    if (url.pathname === '/' && (method === 'GET' || method === 'HEAD')) {
      sendJson(res, 200, {
        server: SERVER_NAME,
        version: SERVER_VERSION,
        transport: 'streamable-http',
        endpoint: config.basePath,
        authentication: 'oauth',
        documentation: 'https://github.com/weather-mcp/weather-mcp#remote-http-server'
      });
      return;
    }

    if (url.pathname === metadataPath && (method === 'GET' || method === 'HEAD')) {
      sendJson(res, 200, {
        resource: config.oidcAudience,
        authorization_servers: [config.oidcIssuer],
        bearer_methods_supported: ['header'],
        resource_name: 'Weather MCP'
      });
      return;
    }

    if (url.pathname !== config.basePath) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    // --- MCP endpoint ------------------------------------------------------

    // Stateless mode has no server-initiated stream to open and no session to
    // delete, so only POST is meaningful here.
    if (method !== 'POST') {
      sendJsonRpcError(
        res,
        405,
        JSONRPC_INVALID_REQUEST,
        'This endpoint is stateless Streamable HTTP: only POST is supported.',
        { Allow: 'POST' }
      );
      return;
    }

    const rawToken = bearerToken(req.headers.authorization);
    if (!rawToken) {
      logger.warn('Rejected unauthenticated MCP request', {
        service: 'http',
        route: config.basePath,
        securityEvent: true
      });
      sendJsonRpcError(
        res,
        401,
        JSONRPC_UNAUTHORIZED,
        'Missing OAuth access token.',
        { 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"` }
      );
      return;
    }

    let tenantId: string;
    try {
      const identity = await authorizer.authorize(rawToken);
      tenantId = aliases.resolve(identity.slug);
    } catch (error) {
      const failure = error instanceof AuthFailure
        ? error
        : new AuthFailure('unavailable', 'The user authorization service is unavailable.');
      const status = failure.kind === 'unauthorized' ? 401 : failure.kind === 'forbidden' ? 403 : 503;
      const code = failure.kind === 'unauthorized'
        ? JSONRPC_UNAUTHORIZED
        : failure.kind === 'forbidden' ? JSONRPC_FORBIDDEN : JSONRPC_UNAVAILABLE;
      logger.warn('Rejected MCP request', {
        service: 'http', route: config.basePath, reason: failure.kind, securityEvent: true
      });
      const headers: Record<string, string> = status === 401
        ? { 'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${metadataUrl}"` }
        : {};
      sendJsonRpcError(res, status, code, failure.message, headers);
      return;
    }

    const decision = rateLimiter.take(tenantId);
    if (!decision.allowed) {
      logger.warn('Rate limit exceeded', {
        service: 'http',
        tenantId,
        securityEvent: true
      });
      sendJsonRpcError(
        res,
        429,
        JSONRPC_INVALID_REQUEST,
        'Rate limit exceeded. Slow down and retry.',
        { 'Retry-After': String(decision.retryAfterSeconds) }
      );
      return;
    }

    const rawBody = await readBody(req, config.maxBodyBytes);
    if (rawBody === null) {
      // The rest of the body is never read, so the connection cannot be reused.
      res.on('finish', () => req.destroy());
      sendJsonRpcError(res, 413, JSONRPC_INVALID_REQUEST, 'Request body too large.', {
        Connection: 'close'
      });
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = rawBody === '' ? undefined : JSON.parse(rawBody);
    } catch {
      sendJsonRpcError(res, 400, JSONRPC_PARSE_ERROR, 'Request body is not valid JSON.');
      return;
    }

    const server = createWeatherServer({
      locationStore: tenants.getLocationStore(tenantId),
      chatgptCompat: config.chatgptCompat
    });

    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session id is issued and none is validated.
      sessionIdGenerator: undefined,
      enableJsonResponse: config.jsonResponse,
      enableDnsRebindingProtection:
        config.allowedHosts.length > 0 || config.allowedOrigins.length > 0,
      allowedHosts: config.allowedHosts.length > 0 ? config.allowedHosts : undefined,
      allowedOrigins: config.allowedOrigins.length > 0 ? config.allowedOrigins : undefined
    });

    // Tear both down once the response is finished, whether it completed or the
    // client hung up mid-stream.
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      logger.error('MCP request failed', error as Error, {
        service: 'http',
        tenantId
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, JSONRPC_INVALID_REQUEST, 'Internal server error.');
      } else {
        res.end();
      }
    }
  };
}

/**
 * Assemble the HTTP server and its per-tenant state from a validated config.
 */
export function createHttpServer(
  config: HttpConfig,
  overrides: { authorizer?: WeatherAuthorizer; aliases?: TenantAliases } = {}
): { server: NodeHttpServer; rateLimiter: RateLimiter } {
  const authorizer = overrides.authorizer ?? new GarminBackedAuthorizer(config);
  const aliases = overrides.aliases ?? new TenantAliases(config.tenantAliasesFile);
  const tenants = new TenantRegistry(config.dataDir);
  const rateLimiter = new RateLimiter(config.rateLimitPerMinute);
  rateLimiter.startSweeping();

  const listener = createRequestListener({ config, authorizer, aliases, tenants, rateLimiter });
  const server = createServer((req, res) => {
    void listener(req, res).catch(error => {
      logger.error('Unhandled HTTP error', error as Error, { service: 'http' });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, JSONRPC_INVALID_REQUEST, 'Internal server error.');
      } else {
        res.end();
      }
    });
  });

  return { server, rateLimiter };
}
