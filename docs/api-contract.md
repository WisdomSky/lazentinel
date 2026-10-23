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

## Endpoints

### `GET /api/health`
`200 { "status": "ok" }`

### `GET /api/products`
`200 { "products": Product[] }`

### `POST /api/products`
Body: `{ "url": string }`

Fetches the Lazada page, stores metadata + the first price point, and starts tracking.

- `201 { "product": Product, "warning"?: string }` — product created. `warning` is set when the product page was read but its price was unavailable.
- `400` invalid URL.
- `409` product is already tracked.
- `422` the URL could not be resolved to a readable Lazada product page.

### `DELETE /api/products/:id`
`204` on success, `404` if not found.

### `POST /api/products/:id/refresh`
Runs a check immediately. `200 { "product": Product, "warning"?: string }`, `404` if not found, `422` on scrape failure.

### `GET /api/settings`
`200 { "trackingIntervalSeconds": number }`

### `PUT /api/settings`
Body: `{ "trackingIntervalSeconds": number }`

Integer between 5 and 86400. `200` with the saved settings; `400` on invalid input.

## Scraper requirements

- Accept Lazada marketplaces (`lazada.sg`, `.com.my`, `.co.th`, `.com.ph`, `.co.id`, `.vn`) and share hosts (`s.lazada.*`).
- Extract title, brand, rating, review count, price, currency and image.
- The price must be the **currently displayed sale price**, not the struck-through
  original/list price. Current Lazada HTML exposes `data.root.fields.tracking.pdt_price`,
  which is the original price for discounted products; it must not be used as the tracked
  price when the client-side PDP data is available. The production scraper renders the
  page in headless Chromium and reads `skuInfos[sku].price.salePrice` and
  `review.averageRating` / `review.reviews` from the Mtop getDetailInfo response.
- If the live displayed price cannot be read, record no price point and surface a warning;
  never fall back to the HTML list price.
- Missing rating/review data must not fail the scrape; store `null` and show it as
  "No ratings yet".
- When the price is not present, still return the product metadata with `price: null`
  so the product can be added and retried.
