# Lazentinel

**Lazada + Sentinel.** Lazentinel is a self-hosted Lazada price watchlist. Paste a product URL once and the server checks it in the background, records every price observation in SQLite, and serves a live, animated dashboard that shows the biggest price drops first.

![Lazentinel](docs/screenshot.png)

> The screenshot is generated from the included demo data.

## Features

- Add any Lazada product by URL (Singapore, Malaysia, Thailand, Philippines, Indonesia and Vietnam).
- Tracks the **displayed sale price** — not the struck-through original/list price — plus the live rating and review count.
- Background tracking on an interval you choose from Settings (default **300 seconds**, minimum 5).
- SQLite persistence — products and full price history survive restarts.
- Product cards with title, brand, rendered stars, review count, current price, drop badge and a chronological price chart.
- Live reordering by price drop percentage, animated with a FLIP transition so cards can be followed while they move.
- A **Live** switch next to Settings that pauses all browser updates (charts and card order) while the server keeps tracking.
- Add, delete and "check now" actions, with clear loading, warning and error states.
- Light and dark themes with a system-aware initial preference and a header toggle.
- Single-page app served by the same Express server; multi-stage Docker image with a persistent data volume.

## How "price drop" is calculated

For each product, the backend finds the latest price and the most recent **earlier price that differs from it** (the previous price level). The drop is:

```text
dropPercent = (previousPrice - currentPrice) / previousPrice * 100
```

Positive means the price fell; negative means it rose. Products are sorted by `dropPercent` descending, then by id. Using the previous *different* price keeps a drop visible while the price stays flat, instead of resetting to zero on every check.

## Tech stack

| Layer     | Choice                                              |
| --------- | --------------------------------------------------- |
| Backend   | Node.js 24, Express 5, TypeScript, better-sqlite3   |
| Pricing   | Playwright + headless Chromium                      |
| Frontend  | Vue 3, Vite 8, TypeScript, TailwindCSS 4, SCSS      |
| UI        | Shadcn-style components built on Reka UI, Chart.js  |
| Database  | SQLite (WAL mode)                                   |
| Packaging | Multi-stage Dockerfile + Docker Compose             |

## Quick start (development)

Requirements: Node.js 22+, npm, and Chromium (installed through Playwright in one command).

```bash
npm install
npm --prefix client install
npm run setup:browser   # Playwright's Chromium, or use an existing Chrome
npm run dev
```

The renderer also auto-detects a system Chrome/Chromium; `setup:browser` is the reproducible option. Docker users can skip it — the image includes Chromium.

- Frontend: <http://localhost:5173>
- API: <http://localhost:3001>

Vite proxies `/api` to the Express server. The SQLite file is created at `./data/lazentinel.db`.

### Optional demo data

An empty dashboard is hard to evaluate. The included seed script adds four realistic demo products with several days of price history:

```bash
npm run seed:demo
```

The script refuses to overwrite existing products unless you pass `--force`. With `--force` it only replaces the four known demo URLs, never your other products. Demo entries use placeholder product URLs for a stable screenshot, so their later background checks will fail; use real Lazada URLs for actual tracking.

### Themes

Lazentinel follows your operating system's light/dark preference on first visit and
remembers the last choice. Use the sun/moon button in the header to switch themes.

<details>
<summary>Dark mode preview</summary>

![Lazentinel in dark mode](docs/screenshot-dark.png)

</details>

## Run with Docker

```bash
npm run docker
```

This builds the image and starts it in the background via Docker Compose. Stop it with:

```bash
npm run docker:down
```

The equivalent raw commands are `docker compose up --build -d` and `docker compose down`. Open <http://localhost:3000>. Data is stored in the `lazentinel-data` named volume. The image includes Playwright Chromium so Lazada's client-side sale price can be read; expect a larger image and additional build time. To use a different host port:

```bash
APP_PORT=8080 npm run docker
```

The published multi-architecture image is available at
[`wisdomsky/lazentinel`](https://hub.docker.com/r/wisdomsky/lazentinel):

```bash
docker pull wisdomsky/lazentinel:latest
docker run -d --name lazentinel \
  -p 3000:3000 \
  -v lazentinel-data:/app/data \
  --restart unless-stopped \
  wisdomsky/lazentinel:latest
```

To build a local image instead:

```bash
docker build -t wisdomsky/lazentinel:latest .
```

## Production build without Docker

```bash
npm install
npm --prefix client install
npm run build
PORT=3000 DATABASE_PATH=./data/lazentinel.db npm start
```

The Express server serves both the API and the built SPA from `client/dist`.

## Publishing to Docker Hub

The GitHub Actions workflow at
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml)
builds and publishes `wisdomsky/lazentinel` for `linux/amd64` and `linux/arm64`
on every push to `main`/`master` and on `v*.*.*` tags. It also supports manual
`workflow_dispatch` runs. The Vitest suite and full typecheck run before any
image is pushed.

Configure these repository secrets:

| Secret | Required | Description |
| ------ | -------- | ----------- |
| `DOCKERHUB_TOKEN` | yes | Docker Hub access token with Read & Write permission |
| `DOCKERHUB_USERNAME` | no | Defaults to `wisdomsky` |

Images are tagged with `latest` on the default branch, `sha-<shortsha>` for each
build, and semantic tags for version tags such as `v1.2.3`.

## Configuration

| Variable         | Default               | Description                                  |
| ---------------- | --------------------- | -------------------------------------------- |
| `PORT`           | `3000`                | HTTP port                                    |
| `DATABASE_PATH`  | `./data/lazentinel.db` | SQLite file (parent directory is created)   |
| `CLIENT_DIST`    | `./client/dist`       | Directory of the built Vue app               |
| `CHROMIUM_EXECUTABLE` | auto        | Optional path to Chrome/Chromium             |

Copy `.env.example` to `.env` for local overrides (already-set environment variables win). The tracking interval is not an environment variable; it is stored in SQLite and managed through Settings. Default 300 s, allowed 5–86400 s.

The application, package, Docker image, container, volume and default SQLite file now use the Lazentinel name. If you are upgrading from an earlier checkout, move your existing database to `data/lazentinel.db`, or point `DATABASE_PATH` at the old file, before starting the server.

## API

| Method   | Path                         | Purpose                              |
| -------- | ---------------------------- | ------------------------------------ |
| `GET`    | `/api/health`                | Health check                         |
| `GET`    | `/api/products`              | Products + history, already sorted   |
| `POST`   | `/api/products`              | Add a product (`{ url }`)            |
| `DELETE` | `/api/products/:id`          | Stop tracking and delete history     |
| `POST`   | `/api/products/:id/refresh`  | Check one product immediately        |
| `GET`    | `/api/settings`              | Current settings                     |
| `PUT`    | `/api/settings`              | Update `trackingIntervalSeconds`     |

The full response contract is in [`docs/api-contract.md`](docs/api-contract.md).

## Scraper notes and limitations

Lazada is a client-rendered, anti-bot-protected storefront. The actual displayed price is not in the server HTML for discounted items — the HTML's `pdt_price` tracking field contains the original price (e.g. ₱13,990 while the product is on sale for ₱3,000). The tracker therefore:

1. Renders the product page in headless Chromium and reads the successful
   `mtop.global.detail.web.getDetailInfo` response. Its `skuInfos[sku].price.salePrice`
   is the displayed sale price, and its `review` object supplies the rating and review count.
2. Uses the server HTML only for fallback metadata (title, brand, image, currency) if
   the browser render is unavailable. It deliberately does **not** fall back to the HTML
   `pdt_price` for a price, so it can never record a struck-through original price as the
   current price. The card shows a warning and retries on the next interval instead.

This is a best-effort public-page reader, not an official API. Lazada can rate-limit,
geo-restrict or change its markup, and some pages will not expose their client-side data
to every request. In that case the product keeps its last known price and displays a retry
warning. Handle Chromium as you would any local browser process, use respectful intervals,
and follow Lazada's terms.

The card below shows the corrected extraction for a discounted Lazada PH listing: the
tracked price is the displayed sale price, and Lazada's live rating/review summary is used.

![A tracked product showing the displayed sale price and review summary](docs/screenshot-sale-price.png)

> Upgrading from the HTML-only scraper? Existing price history may contain the old
> struck-through list price. Delete and re-add the affected products to start a clean
> history; new checks no longer record the wrong price.

## Scripts

| Command               | Description                                |
| --------------------- | ------------------------------------------ |
| `npm run dev`         | Run API + Vite dev server with hot reload  |
| `npm run build`       | Build server and client                    |
| `npm start`           | Start the compiled server                  |
| `npm test`            | Run Vitest tests                           |
| `npm run typecheck`   | Type-check server and client               |
| `npm run seed:demo`   | Seed four demo products with price history |
| `npm run setup:browser` | Download Playwright Chromium for dev     |
| `npm run docker`      | Build and start the app with Docker Compose |
| `npm run docker:down` | Stop the Docker Compose app                |

## Project structure

```text
.
├── .github/workflows/     Docker Hub publishing workflow
├── client/                Vue SPA (components, composables, styles)
├── server/                Express API, SQLite, scraper, tracker
│   └── browser-renderer.ts  Chromium + Mtop displayed-price extraction
├── docs/                  API contract and screenshots
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Disclaimer

Lazentinel is not affiliated with or endorsed by Lazada. It is intended for personal price tracking. Respect the site's terms of service and avoid aggressive polling intervals.
