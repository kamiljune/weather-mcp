# Weather MCP Server — Streamable HTTP image.
#
# Serves the MCP endpoint over HTTP so hosted assistants (Claude custom
# connectors, ChatGPT connectors) can reach it at a public URL. The stdio entry
# point is in the image too (`node dist/index.js`) but is not the default command.

FROM node:22-alpine AS build

WORKDIR /app

# Dependencies first so the layer caches across source edits.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

# tini reaps zombies and forwards SIGTERM, so graceful shutdown actually runs.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Saved locations live here, one directory per API key. Mount a volume to keep them.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

ENV WEATHER_HTTP_HOST=0.0.0.0 \
    WEATHER_HTTP_PORT=8080 \
    WEATHER_DATA_DIR=/data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEATHER_HTTP_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/http/index.js"]
