# syntax=docker/dockerfile:1

# ---------- Client build ----------
FROM node:24-bookworm-slim AS client-build
WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY client/ ./
RUN npm run build

# ---------- Server build ----------
FROM node:24-bookworm-slim AS server-build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY server ./server
RUN npm run build:server \
  && npm prune --omit=dev --no-audit --no-fund

# ---------- Runtime ----------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/lazentinel.db \
    AUTH_DATABASE_PATH=/app/data/lazentinel-auth.db \
    CLIENT_DIST=/app/client/dist \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=server-build /app/node_modules ./node_modules
COPY --from=server-build /app/dist ./dist
COPY --from=client-build /app/client/dist ./client/dist
COPY package.json ./

# Lazada loads the displayed sale price and ratings in its client-side Mtop
# request, so production includes Playwright's Chromium for accurate prices.
RUN node node_modules/playwright-core/cli.js install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/data \
  && chown -R node:node /app /ms-playwright

USER node

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
