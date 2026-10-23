import type {
  ProductRenderer,
  RenderRequest,
  RenderedProduct,
} from '../../browser-renderer.js';
import type { ScrapeResult, ScrapedProduct, ScraperLike } from '../../scraper.js';
import type { ServiceLogger } from '../../service.js';

export type ScrapeHandler = (url: string) => ScrapeResult | Promise<ScrapeResult>;

/**
 * Deterministic in-memory scraper. Every call is recorded and routed through a
 * mutable handler so tests can change behaviour between operations without any
 * network access.
 */
export class FakeScraper implements ScraperLike {
  readonly calls: string[] = [];
  handler: ScrapeHandler;

  constructor(handler: ScrapeHandler = () => ({ product: makeScrapedProduct() })) {
    this.handler = handler;
  }

  async scrape(inputUrl: string): Promise<ScrapeResult> {
    this.calls.push(inputUrl);
    return this.handler(inputUrl);
  }
}

export const DEFAULT_PRODUCT_URL = 'https://www.lazada.sg/products/test-product-i123.html';

export function makeScrapedProduct(overrides: Partial<ScrapedProduct> = {}): ScrapedProduct {
  return {
    url: DEFAULT_PRODUCT_URL,
    title: 'Test Product',
    brand: 'Test Brand',
    rating: 4.5,
    reviewCount: 42,
    currency: 'SGD',
    imageUrl: 'https://img.lazada.com/test.jpg',
    price: 100,
    sku: 'SKU-1',
    ...overrides,
  };
}

export type RenderHandler = (
  request: RenderRequest,
) => RenderedProduct | Promise<RenderedProduct>;

/** In-memory ProductRenderer; never starts a browser. */
export class FakeRenderer implements ProductRenderer {
  readonly requests: RenderRequest[] = [];
  readonly usesProxy?: boolean;
  closeCalls = 0;
  handler: RenderHandler;

  constructor(
    handler: RenderHandler = () => makeRenderedProduct(),
    options: { usesProxy?: boolean } = {},
  ) {
    this.handler = handler;
    this.usesProxy = options.usesProxy;
  }

  async render(request: RenderRequest): Promise<RenderedProduct> {
    this.requests.push({ ...request });
    return this.handler(request);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

export function makeRenderedProduct(
  overrides: Partial<RenderedProduct> = {},
): RenderedProduct {
  return {
    url: DEFAULT_PRODUCT_URL,
    title: 'Rendered Product',
    brand: 'Rendered Brand',
    rating: 4.7,
    reviewCount: 88,
    price: 3_000,
    currency: 'SGD',
    imageUrl: 'https://img.lazada.com/rendered.jpg',
    sku: 'SKU-RENDERED',
    ...overrides,
  };
}

export interface TestClock {
  now: () => Date;
  advance(ms: number): void;
  set(iso: string): void;
  iso(): string;
}

/** Small controllable clock injected through ProductServiceOptions.now. */
export function createClock(startIso = '2026-01-01T00:00:00.000Z'): TestClock {
  let current = new Date(startIso);
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    set(iso: string) {
      current = new Date(iso);
    },
    iso() {
      return current.toISOString();
    },
  };
}

export const silentLogger: ServiceLogger = {
  error: () => {
    /* silence expected failure logging */
  },
  info: () => {
    /* no-op */
  },
};

export interface FakeResponseOptions {
  status?: number;
  url?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

/**
 * Builds an object with the handful of Response members the scraper reads.
 * `Response.url` is read-only on real instances, so a structural fake is used
 * to control the final (post-redirect) URL deterministically.
 */
export function fakeResponse(body: string, options: FakeResponseOptions = {}): Response {
  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: options.url ?? '',
    headers: new Headers({
      'content-type': options.contentType ?? 'text/html; charset=utf-8',
      ...options.headers,
    }),
    text: async () => body,
  } as unknown as Response;
}

export type StubFetchHandler = (
  input: string,
  init: RequestInit,
) => Response | Promise<Response>;

/** Adapts a handler into a `typeof fetch` compatible implementation stub. */
export function stubFetch(handler: StubFetchHandler): typeof fetch {
  return (async (input: unknown, init?: RequestInit) =>
    handler(String(input), init ?? {})) as unknown as typeof fetch;
}
