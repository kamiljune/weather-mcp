# Remote deployment — Streamable HTTP

This guide turns the weather MCP server into a hosted service at a domain of
your own (the examples use `weather.laputa.one`), reachable by Claude custom
connectors and ChatGPT connectors.

- **Transport:** MCP Streamable HTTP, stateless
- **Endpoint:** `POST https://weather.laputa.one/mcp`
- **Auth:** Auth0 OAuth access token in `Authorization: Bearer`
- **Entry point:** `dist/http/index.js` (`npm run start:http`)

The stdio entry point is untouched: `npx @dangahagan/weather-mcp` still works
exactly as before, and nothing in this guide affects it.

---

## 1. Configure Auth0 and user authorization

Create a dedicated Auth0 API whose Identifier is exactly:

```text
https://weather.laputa.one/mcp
```

The Auth0 tenant, login connections and imported Claude/ChatGPT CIMD clients may
be shared with Garmin, but the Garmin and Weather API identifiers are different.
Weather validates its own token, then forwards it over a private Docker network
to Garmin's `/internal/weather/identity`. Garmin validates the Weather audience
again and returns a slug only when that Auth0 `sub` belongs to an active
`/connect` user. Missing, unknown and inactive users are never auto-created.

Saved locations remain per tenant. The Garmin slug is the default tenant id;
preserve an old directory name with `config/tenant-aliases.json`:

```json
{ "slug_aliases": { "user4": "lihao" } }
```

Both slugs and tenant ids are restricted to lowercase letters, digits, dash and
underscore. The alias file is read at startup. `/config/` and `/data/` are
gitignored; never commit real user data or tokens.

---

## 2. Run the container

```bash
git clone https://github.com/weather-mcp/weather-mcp.git
cd weather-mcp
cp .env.http.example .env
mkdir -p config && cp tenant-aliases.example.json config/tenant-aliases.json
docker network inspect mcp-internal >/dev/null 2>&1 || docker network create --internal mcp-internal
docker compose up -d --build
```

Verify locally before wiring up the domain:

```bash
curl -s http://127.0.0.1:8787/healthz
# {"status":"ok","server":"weather-mcp","version":"1.23.0"}

TOKEN=your-weather-auth0-access-token
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
```

The compose file publishes on `127.0.0.1:8787` only — the public hostname and
TLS belong to the reverse proxy.

**Saved locations** live in `./data`, one directory per tenant id —
`./data/kamil/locations.json`. Back that directory up; deleting it loses
everyone's aliases. Use the alias file to preserve a legacy directory name.

---

## 3. Reverse proxy

### 1Panel

1. **网站 → 创建网站 → 反向代理**
   - 主域名: `weather.laputa.one`
   - 代理地址: `http://127.0.0.1:8787`
2. **网站 → 该站点 → HTTPS**: select your existing certificate and enable it.
   Turn on HTTP → HTTPS redirect.
3. **网站 → 该站点 → 配置文件**: add the settings below inside the `server`
   block, then save and reload.

```nginx
# Access tokens stay in the Authorization header; never log that header.

location /mcp {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection        "";

    # Required if you switch WEATHER_HTTP_JSON_RESPONSE=false (SSE responses).
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding off;

    # A cold forecast fan-out can take a while on first call.
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}

location = /healthz {
    proxy_pass http://127.0.0.1:8787;
}
```

> **If the proxy cannot reach `127.0.0.1:8787`**: attach OpenResty and Weather
> to a separate proxy network and use `http://weather-mcp:8080` as the upstream.
> Keep `mcp-internal` private to Garmin and Weather; it carries the internal
> authorization request and must not become a public proxy network.

Weather and Garmin also retain their own Compose `default` networks. Those
networks provide outbound access to Auth0 and weather/Garmin APIs and keep the
loopback port publications working; `mcp-internal` is not their default route.

### Plain nginx or Caddy

The same headers apply. For Caddy:

```caddyfile
weather.laputa.one {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}
```

### Behind Cloudflare

Cloudflare in front of the origin works, but two of its defaults will break or
weaken this deployment. Both bite only when the record is **proxied** (orange
cloud); a DNS-only (grey cloud) record behaves like any other host.

**1. Bot protection blocks the connectors.** Claude's and ChatGPT's connectors
are server-side HTTP clients, not browsers: no cookies, no JavaScript, and a
non-browser user agent. Bot Fight Mode, "Block AI bots/scrapers", and most
managed WAF bot rules will challenge or drop them, and the client reports it as
a plain connection failure with nothing in the origin logs — because the request
never reached the origin. If the endpoint answers over loopback but not over the
domain, check the Cloudflare **Security → Events** log before touching anything
on the server.

Fix by exempting the endpoint. Security → WAF → Custom rules, a **Skip** rule:

```
(http.host eq "weather.laputa.one" and starts_with(http.request.uri.path, "/mcp"))
```

skipping Bot Fight Mode / Super Bot Fight Mode, managed rules, and rate limiting.
Also switch off **Block AI bots** for this hostname if it is enabled — the tools
are being called *by* an AI assistant on purpose.

**2. Never cache the OAuth endpoint.** Access tokens are carried in the
`Authorization` header, not the URL. Do not create a Cache Rule for `/mcp`, and
do not configure any proxy to log authorization headers.

Two smaller notes: the free plan drops a request whose origin takes longer than
**100 seconds** (error 524) — comfortably above a normal call, but a cold
`get_weather_summary` fanning out to many upstreams is the one that could reach
it; and keep `WEATHER_HTTP_JSON_RESPONSE=true` (the default), since a single JSON
body passes through Cloudflare without the buffering questions SSE raises.

### After the domain is live

Set the Host allowlist so the server rejects requests arriving under any other
name, then restart:

```
WEATHER_HTTP_ALLOWED_HOSTS=weather.laputa.one
```

Cloudflare preserves the original `Host` header when proxying, so this works
unchanged behind an orange-cloud record.

---

## 4. Connect Claude

**Claude web / desktop** — Settings → Connectors → Add custom connector:

```
https://weather.laputa.one/mcp
```

Leave authentication fields empty. The 401 challenge and protected-resource
metadata start Auth0 OAuth automatically.

**Claude Code:**

```bash
claude mcp add --transport http weather https://weather.laputa.one/mcp
```

## 5. Connect ChatGPT

Settings → Connectors → Create, choose OAuth and use:

```
https://weather.laputa.one/mcp
```

ChatGPT's **deep research** connector only calls two tools, `search` and
`fetch`. Set `WEATHER_CHATGPT_COMPAT=true` to expose them: `search` geocodes a
place name into result documents, and `fetch` expands one into that place's
weather summary. They are added alongside the native tools, not instead of them,
and are off by default so Claude's tool list is unchanged.

---

## Endpoint reference

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/mcp` | OAuth-protected MCP endpoint |
| `GET` | `/.well-known/oauth-protected-resource/mcp` | RFC 9728 resource metadata |
| `GET` | `/healthz` | Liveness probe (no auth) |
| `GET` | `/` | Endpoint discovery |

Failure responses are JSON-RPC error objects:

| Status | Meaning |
|---|---|
| 400 | Body is not valid JSON |
| 401 | Missing, invalid, expired, wrong-issuer or wrong-audience OAuth token |
| 403 | Valid token, but the Auth0 sub is not an active Garmin `/connect` user |
| 404 | Unknown path |
| 405 | Anything but `POST` on the MCP endpoint (the transport is stateless: no GET stream, no session to DELETE) |
| 413 | Body over `WEATHER_HTTP_MAX_BODY_BYTES` |
| 429 | Over `WEATHER_HTTP_RATE_LIMIT` for that tenant; see `Retry-After` |
| 503 | Garmin's private authorization endpoint is unavailable or malformed |

## Operational notes

- **Stateless by design.** Every request builds a server, answers, and tears it
  down. Restarts and multiple replicas are invisible to clients. Only the
  upstream response caches and saved locations outlive a request.
- **Run it as a long-lived process, not a serverless function.** The LRU caches
  and the lightning tool's persistent MQTT connection both assume a process that
  stays up.
- **Rate limiting is per tenant, per process.** A Garmin slug, after any legacy
  alias mapping, owns one budget; two replicas mean two budgets.
- **Authorization is deliberately uncached.** Garmin user deactivation takes
  effect on the next request. If Garmin is unavailable, Weather fails closed.
- **Upstream courtesy.** NOAA, Open-Meteo, Nominatim and the rest are free
  services with their own limits. `WEATHER_HTTP_RATE_LIMIT` is what stands
  between a runaway client and your IP getting blocked upstream.
- **Logs never contain access tokens or Auth0 sub values.** Security events use
  only the final tenant id and a fixed reason class.
