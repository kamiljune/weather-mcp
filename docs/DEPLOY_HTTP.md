# Remote deployment — Streamable HTTP

This guide turns the weather MCP server into a hosted service at a domain of
your own (the examples use `weather.laputa.one`), reachable by Claude custom
connectors and ChatGPT connectors.

- **Transport:** MCP Streamable HTTP, stateless
- **Endpoint:** `POST https://weather.laputa.one/mcp/<api-key>`
- **Auth:** an API key in the URL path, or `Authorization: Bearer <key>`
- **Entry point:** `dist/http/index.js` (`npm run start:http`)

The stdio entry point is untouched: `npx @dangahagan/weather-mcp` still works
exactly as before, and nothing in this guide affects it.

---

## 1. Generate API keys

One key per client, so you can revoke one without disturbing the other:

```bash
openssl rand -base64 32 | tr -d '=+/'
```

Keys must be at least 24 characters — the server refuses to start on anything
shorter. Label them for readable logs:

```
WEATHER_API_KEYS=claude:Xk9...,chatgpt:Qm2...
```

Labels are cosmetic. Only the key is checked, and only its SHA-256 is kept in
memory; the raw key never reaches a log line, an error message, or a file path.

### What a key in the URL costs you

Putting a secret in a URL is a real trade-off, and it is the right one here only
because several client UIs cannot send a custom header. Understand the exposure:

| Risk | Mitigation |
|---|---|
| The key lands in reverse-proxy access logs | Turn off access logging for the MCP location (§3), or use the `Authorization` header where the client supports it |
| The key appears in browser history / `Referer` | Nothing on this server pastes the URL into a page; do not paste it into one yourself |
| A leaked key is usable by anyone | Keys are independent — drop the leaked entry from `WEATHER_API_KEYS` and restart |

There is no user model behind a key, so treat each one as full access to the
tools and to that key's saved locations.

---

## 2. Run the container

```bash
git clone https://github.com/weather-mcp/weather-mcp.git
cd weather-mcp
cp .env.http.example .env
$EDITOR .env                 # set WEATHER_API_KEYS at minimum
docker compose up -d --build
```

Verify locally before wiring up the domain:

```bash
curl -s http://127.0.0.1:8787/healthz
# {"status":"ok","server":"weather-mcp","version":"1.23.0"}

KEY=your-key-here
curl -s -X POST http://127.0.0.1:8787/mcp/$KEY \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
```

The compose file publishes on `127.0.0.1:8787` only — the public hostname and
TLS belong to the reverse proxy.

**Saved locations** live in `./data`, one directory per key (named by a hash
prefix of the key, never the key itself). Back that directory up; deleting it
loses everyone's aliases.

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
# The API key travels in the request path — keep it out of the access log.
access_log off;

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

> **If the proxy cannot reach `127.0.0.1:8787`**: 1Panel's OpenResty runs in its
> own container, so loopback on the host may not resolve to the app. In that
> case uncomment the `1panel-network` blocks in `docker-compose.yml`, recreate
> the container, and change `proxy_pass` to `http://weather-mcp:8080`.

### Plain nginx or Caddy

The same headers apply. For Caddy:

```caddyfile
weather.laputa.one {
    log {
        # The key is in the path; don't record it.
        output discard
    }
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}
```

### After the domain is live

Set the Host allowlist so the server rejects requests arriving under any other
name, then restart:

```
WEATHER_HTTP_ALLOWED_HOSTS=weather.laputa.one
```

---

## 4. Connect Claude

**Claude web / desktop** — Settings → Connectors → Add custom connector:

```
https://weather.laputa.one/mcp/<your-claude-key>
```

**Claude Code** — the header form keeps the key out of the URL:

```bash
claude mcp add --transport http weather https://weather.laputa.one/mcp \
  --header "Authorization: Bearer <your-claude-key>"
```

## 5. Connect ChatGPT

Settings → Connectors → Create, with the same URL form:

```
https://weather.laputa.one/mcp/<your-chatgpt-key>
```

If the UI offers an API-key authentication option, use it with the bare
`/mcp` URL — it sends `Authorization: Bearer`, which this server accepts.

ChatGPT's **deep research** connector only calls two tools, `search` and
`fetch`. Set `WEATHER_CHATGPT_COMPAT=true` to expose them: `search` geocodes a
place name into result documents, and `fetch` expands one into that place's
weather summary. They are added alongside the native tools, not instead of them,
and are off by default so Claude's tool list is unchanged.

---

## Endpoint reference

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/mcp/<key>` | MCP endpoint, key in the path |
| `POST` | `/mcp` | MCP endpoint, key in `Authorization: Bearer` or `?key=` |
| `GET` | `/healthz` | Liveness probe (no auth) |
| `GET` | `/` | Endpoint discovery (no auth, no secrets) |

Failure responses are JSON-RPC error objects:

| Status | Meaning |
|---|---|
| 400 | Body is not valid JSON |
| 401 | Missing or unknown API key |
| 404 | Unknown path |
| 405 | Anything but `POST` on the MCP endpoint (the transport is stateless: no GET stream, no session to DELETE) |
| 413 | Body over `WEATHER_HTTP_MAX_BODY_BYTES` |
| 429 | Over `WEATHER_HTTP_RATE_LIMIT` for that key; see `Retry-After` |

## Operational notes

- **Stateless by design.** Every request builds a server, answers, and tears it
  down. Restarts and multiple replicas are invisible to clients. Only the
  upstream response caches and saved locations outlive a request.
- **Run it as a long-lived process, not a serverless function.** The LRU caches
  and the lightning tool's persistent MQTT connection both assume a process that
  stays up.
- **Rate limiting is per process.** Two replicas mean two budgets.
- **Upstream courtesy.** NOAA, Open-Meteo, Nominatim and the rest are free
  services with their own limits. `WEATHER_HTTP_RATE_LIMIT` is what stands
  between a runaway client and your IP getting blocked upstream.
- **Logs never contain key material** — only a 12-character hash prefix
  (`keyId`) and the operator-chosen label.
