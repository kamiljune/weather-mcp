# About this fork

This repository is a fork of **[weather-mcp/weather-mcp](https://github.com/weather-mcp/weather-mcp)**
by Dan Gahagan, MIT licensed. All 17 weather tools, every upstream service
integration, and the whole test suite are his work; this fork adds a way to run
that server as a hosted HTTP service instead of only as a local stdio process.

It tracks upstream and intends to stay mergeable with it.

## What this fork adds

A **Streamable HTTP transport**, so hosted assistants (Claude custom connectors,
ChatGPT connectors) can reach the tools at a URL instead of spawning a local
process. Deployment walkthrough: **[docs/DEPLOY_HTTP.md](./docs/DEPLOY_HTTP.md)**.

| Area | What changed |
|---|---|
| Entry points | `src/index.ts` reduced to a stdio entry over a new `createWeatherServer()` factory (`src/server/weatherServer.ts`); `src/http/index.ts` added as a second entry point |
| Transport | `src/http/` — stateless Streamable HTTP, routing, tenant auth, per-tenant rate limiting |
| Multi-caller state | Saved locations namespaced per tenant; `LocationStore` gained an optional `disclosePath` flag so HTTP output does not name a server directory |
| ChatGPT | `src/server/chatgptCompat.ts` — opt-in `search`/`fetch` tools behind `WEATHER_CHATGPT_COMPAT` |
| Deployment | `Dockerfile`, `docker-compose.yml`, `keys.example.json`, `.env.http.example` |

Everything else — handlers, services, utils, upstream API clients — is unchanged
from upstream. The unit suite passes **unedited**, which is the standing check
that the stdio path still behaves exactly as upstream's.

## Keeping in sync

```bash
git remote add upstream https://github.com/weather-mcp/weather-mcp.git   # once
git fetch upstream main
git merge upstream/main
```

Merge rather than rebase: the fork's commits are already pushed, and rebasing
would invalidate anyone's checkout.

### Where conflicts will show up

Most of the fork is new files, which never conflict. Expect merge work in
exactly these, and nowhere else:

- **`CHANGELOG.md`** — new entries are prepended at the top, and this fork's
  entries live in `[Unreleased]`. Take both sides; keep upstream's released
  sections in their original order.
- **`README.md`** — the fork notice at the top and the "Remote HTTP server"
  section under Installation. Both are additive blocks; keep them and take
  upstream's text around them.
- **`CLAUDE.md`** — the architecture tree, the conventions list, and the
  configuration block all gained HTTP entries.
- **`src/index.ts`** — the biggest one. If upstream changes tool registration or
  dispatch, those changes belong in `src/server/weatherServer.ts` now, not in
  `src/index.ts`. Read the upstream diff and apply it there by hand.
- **`scripts/check-doc-versions.sh`, `scripts/update-docs-for-release.sh`** —
  both were repointed at `src/server/weatherServer.ts` for the tool count.

After any merge: `npm run build && npm test`. The unit suite is the lock — if a
unit test fails without you having edited it, the merge changed behaviour.

## Contributing back

The HTTP transport is written to be upstreamable: it is additive, the stdio path
is byte-identical, and its changelog entries sit in `CHANGELOG.md` where a pull
request would put them. Keep it that way — do not move fork changes into a
separate changelog unless this fork stops tracking upstream.

## What is *not* changed, deliberately

The npm package name (`@dangahagan/weather-mcp`), the MCP registry id
(`io.github.dgahagan/weather-mcp` in `server.json`), and the homepage/issue
links still point at upstream. That is correct while this fork is not published
anywhere: renaming them would only create merge conflicts. **If this fork is
ever published to npm or the MCP registry, those identifiers must be changed
first** — publishing under upstream's names would be claiming their namespace.

`.github/workflows/publish.yml` still exists for the same reason, but is guarded
so it only runs in the upstream repository.

## Attribution

Upstream: <https://github.com/weather-mcp/weather-mcp> — Copyright (c) Dan
Gahagan, MIT. See [LICENSE](./LICENSE), which applies to this fork unchanged.
