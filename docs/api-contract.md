# API contract

All responses are JSON. Errors return an HTTP status plus `{ "error": "<human readable message>" }`.

## Product shape

```ts
interface PricePoint {
  price: number;
  recordedAt: string; // ISO 8601 UTC
}

interface Product {
  id: number;
  url: string;
  title: string;
  brand: string | null;
  rating: number | null; // 0..5
  reviewCount: number | null;
  currency: string; // ISO 4217, e.g. "SGD"
  imageUrl: string | null;
  createdAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  currentPrice: number | null;
  previousPrice: number | null; // most recent earlier price that differs from currentPrice
  priceChange: number | null; // currentPrice - previousPrice
  dropPercent: number; // (previousPrice - currentPrice) / previousPrice * 100, positive = drop, 0 = flat/no data
  lowestPrice: number | null;
  highestPrice: number | null;
  history: PricePoint[]; // last 500 points, oldest first
}
```

Products are ordered by `dropPercent` descending, then `id` ascending.

## Multi-user mode

`ENABLE_MULTIUSER` enables accounts only when its value is exactly `true`.
When disabled, all product/settings endpoints are public and products belong to the
single-user owner scope, exactly as before.

When enabled:

- Accounts and sessions live in a separate SQLite database
  (`AUTH_DATABASE_PATH`, default `./data/lazentinel-auth.db`).
- Passwords are stored in plaintext in the auth database, per the product
  requirement. This is intentionally insecure for public deployments.
- Every `/api/products` and `/api/settings` request requires a valid
  `lazentinel_session` HTTP-only cookie; otherwise it returns `401`.
- Products are scoped to the authenticated owner. List, add, delete and refresh
  operate only on that owner's products. Other owners' product ids return `404`.
- `(ownerId, url)` is unique, so different accounts can track the same Lazada URL
  independently. Duplicate adds within one account return `409`.
- Background tracking continues for all products regardless of which accounts are
  online.

## Auth endpoints

### `GET /api/auth/session`
Public. `200 { "multiUser": boolean, "authenticated": boolean, "user": { "email": string } | null }`.
In single-user mode it returns `multiUser: false, authenticated: true, user: null`.

### `POST /api/auth/register`
Public when multi-user mode is enabled.
Body: `{ "email": string, "password": string, "confirmPassword": string }`.

Creates an account and returns `201 { "user": { "email": string } }`. It does **not**
log the user in; the client returns to the sign-in screen. No email verification is
performed. `400` for validation errors, `409` when the normalized email already exists.

### `POST /api/auth/login`
Public when enabled. Body: `{ "email": string, "password": string }`.

On success returns `200 { "user": { "email": string } }` and sets the
`lazentinel_session` cookie. Invalid credentials return `401`.

### `POST /api/auth/logout`
Clears and invalidates the current session, returning `204`.

## Endpoints

### `GET /api/health`
`200 { "status": "ok" }`

### `GET /api/products`
`200 { "products": Product[] }` — scoped to the authenticated account when enabled.

### `POST /api/products`
Body: `{ "url": string }`

Fetches the Lazada page, stores metadata + the first price point, and starts tracking.

- `201 { "product": Product, "warning"?: string }` — product created. `warning` is set when the product page was read but its price was unavailable.
- `400` invalid URL.
- `401` not authenticated (multi-user mode only).
- `409` product is already tracked by this account.
- `422` the URL could not be resolved to a readable Lazada product page.

### `DELETE /api/products/:id`
`204` on success, `404` if not found or not owned by the authenticated account.

### `POST /api/products/:id/refresh`
Runs a check immediately. `200 { "product": Product, "warning"?: string }`, `404` if not found or not owned, `422` on scrape failure.

### `GET /api/settings`
`200 { "trackingIntervalSeconds": number }` — protected in multi-user mode; the interval is global to the installation. When `DEFAULT_TRACKING_INTERVAL_MINUTES` is set, it is applied on startup and overrides the saved value. When unset, a new database starts at 5 minutes and existing saved values are preserved.

### `PUT /api/settings`
Body: `{ "trackingIntervalSeconds": number }`

Integer between 5 and 86400. `200` with the saved settings; `400` on invalid input.
In multi-user mode this endpoint is read-only and returns `403`, because the
interval is installation-wide and is not editable per account.

## Scraper requirements

- Accept Lazada marketplaces (`lazada.sg`, `.com.my`, `.co.th`, `.com.ph`, `.co.id`, `.vn`) and share hosts (`s.lazada.*`).
- Extract title, brand, rating, review count, price, currency and image.
- The price must be the **currently displayed sale price**, not the struck-through
  original/list price. Current Lazada HTML exposes `data.root.fields.tracking.pdt_price`,
  which is the original price for discounted products; it must not be used as the tracked
  price when the client-side PDP data is available. The production scraper renders the
  page in CloakBrowser's stealth Chromium and reads `skuInfos[sku].price.salePrice` and
  `review.averageRating` / `review.reviews` from the Mtop getDetailInfo response.
- If the live displayed price cannot be read, record no price point and surface a warning;
  never fall back to the HTML list price.
- Lazada requests rotate through the configured proxy pool. Only after every host in
  `proxy_locations.json` has been attempted for one product, try the 2Captcha Browser
  API when `TWOCAPTCHA_API_KEY` is configured. Only if the full proxy sweep and the
  Browser API both fail, return a `BLOCKED` error and stop trying that URL for 3 hours.
- Missing rating/review data must not fail the scrape; store `null` and show it as
  "No ratings yet".
- When the price is not present, still return the product metadata with `price: null`
  so the product can be added and retried.
