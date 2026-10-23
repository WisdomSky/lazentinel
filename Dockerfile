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
    CLOAKBROWSER_CACHE_DIR=/ms-playwright \
    CLOAKBROWSER_AUTO_UPDATE=false

COPY --from=server-build /app/node_modules ./node_modules
COPY --from=server-build /app/dist ./dist
COPY --from=client-build /app/client/dist ./client/dist
COPY package.json ./

# Lazada loads the displayed sale price and ratings in its client-side Mtop
# request, so production bundles CloakBrowser's stealth Chromium instead of a
# stock headless build. System libraries and fonts are the ones its binary
# expects; the browser itself is downloaded now so first scrape stays fast.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libx11-xcb1 libfontconfig1 libx11-6 \
    libxcb1 libxext6 libxshmfence1 \
    libglib2.0-0 libgtk-3-0 libpangocairo-1.0-0 libcairo-gobject2 \
    libgdk-pixbuf-2.0-0 libxss1 libxtst6 ca-certificates \
    fonts-liberation fonts-noto-color-emoji fonts-unifont fonts-freefont-ttf \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-urw-base35 \
  && rm -rf /var/lib/apt/lists/* \
  && node node_modules/cloakbrowser/dist/cli.js install \
  && mkdir -p /app/data \
  && chown -R node:node /app /ms-playwright

USER node

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
