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

## 1. Set up keys

### The model: tenants, not keys

A **tenant** is a person or an installation. The tenant `id` is what identifies
a caller everywhere: it names their saved-location directory and appears in
logs. A tenant owns **one or more keys**, so:

- one person can hold a Claude key *and* a ChatGPT key over the same saved
  locations — save `home` in one, use it from the other;
- a key can be rotated by adding the new one, switching clients over, then
  removing the old one, with **no data loss** — the tenant id never changed;
- a leaked key is revoked on its own, without disturbing anyone else.

Nothing else is scoped per tenant. Every valid key can call every enabled tool;
there is no permission model. A key is a door badge, not an account.

### Generate keys

```bash
openssl rand -base64 32 | tr -d '=+/'
```

At least 24 characters — the server refuses to start on anything shorter. One
key per client installation is the useful granularity.

### The key file (recommended)

```bash
mkdir -p config
cp keys.example.json config/keys.json
$EDITOR config/keys.json
```

```json
{
  "tenants": [
    {
      "id": "kamil",
      "label": "Kamil",
      "keys": ["key-used-by-claude", "key-used-by-chatgpt"]
    },
    { "id": "alice", "keys": ["alices-key"] }
  ]
}
```

`id` is required and becomes a directory name, so it is restricted to `a-z`,
`0-9`, dash and underscore (1–64 characters) — anything else is refused. `label`
is optional and cosmetic. The file is re-read every
`WEATHER_API_KEYS_RELOAD_SECONDS` (default 10), so **adding, rotating or
revoking a person needs no restart**. To apply a change immediately:

```bash
docker compose kill -s HUP weather-mcp
```

Two properties worth relying on:

- **A broken file never locks anyone out.** The running key set is replaced only
  when a new file parses and validates completely. A syntax error, a truncated
  write, or a deleted file leaves the previous set serving and logs the failure.
  Watch for `API key reload failed` in the logs — that means your edit did *not*
  take effect.
- **The file must sit in a mounted directory**, which is why the compose file
  mounts `./config` rather than the file itself. Bind-mounting a single file
  pins an inode, and most editors replace the inode on save; the container would
  go on reading the old file and reload would silently stop working.

### Or: keys in the environment

Simpler, at the cost of a restart per change:

```
WEATHER_API_KEYS=kamil:key-for-claude,kamil:key-for-chatgpt,alice:her-key
```

Entries sharing a name become **one tenant with several keys**, exactly as in
the file form. An unlabelled bare key still works, but its tenant id is derived
from the key itself — so rotating it starts a fresh, empty saved-location
namespace. The server warns about this at startup; name your tenants.

`WEATHER_API_KEYS_FILE` takes precedence when both are set.

### What a key in the URL costs you

Putting a secret in a URL is a real trade-off, and it is the right one here only
because several client UIs cannot send a custom header. Understand the exposure:

| Risk | Mitigation |
|---|---|
| The key lands in reverse-proxy access logs | Turn off access logging for the MCP location (§3), or use the `Authorization` header where the client supports it |
| The key appears in browser history / `Referer` | Nothing on this server pastes the URL into a page; do not paste it into one yourself |
| A leaked key is usable by anyone | Remove that one key from the tenant's `keys` array; the change is live within seconds |

Only the SHA-256 of each key is kept in memory. The raw key never reaches a log
line, an error message, or a filesystem path — logs identify callers by tenant
id and label only.

---

## 2. Run the container

```bash
git clone https://github.com/weather-mcp/weather-mcp.git
cd weather-mcp
cp .env.http.example .env
mkdir -p config && cp keys.example.json config/keys.json
$EDITOR config/keys.json      # define your tenants and their keys
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

**Saved locations** live in `./data`, one directory per tenant id — `./data/kamil/locations.json`.
Back that directory up; deleting it loses everyone's aliases. To rename a tenant,
stop the server, rename both the id in the key file and the directory, and start it again.

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
- **Rate limiting is per tenant, per process.** All of a tenant's keys draw on
  one budget; two replicas mean two budgets.
- **Key changes need no deploy** when using the key file — edit
  `config/keys.json` and the running server picks it up. Confirm with the
  `API keys reloaded` log line, which reports which tenant ids were added and
  removed.
- **Upstream courtesy.** NOAA, Open-Meteo, Nominatim and the rest are free
  services with their own limits. `WEATHER_HTTP_RATE_LIMIT` is what stands
  between a runaway client and your IP getting blocked upstream.
- **Logs never contain key material** — only a 12-character hash prefix
  (`keyId`) and the operator-chosen label.
