import { describe, expect, it } from 'vitest';
import {
  DISPLAYED_PRICE_UNAVAILABLE_WARNING,
  LazadaScraper,
  ScrapeError,
  normalizeLazadaUrl,
  parseLazadaHtml,
  parsePrice,
} from '../scraper.js';
import { RenderBlockedError } from '../browser-renderer.js';
import type { ScrapeErrorCode } from '../scraper.js';
import {
  FakeRenderer,
  fakeResponse,
  makeRenderedProduct,
  stubFetch,
} from './helpers/fakes.js';
import {
  JSON_LD_PRODUCT_FIXTURE,
  MODULE_DATA_FIXTURE,
  jsonLdPage,
  malformedModuleDataPage,
  moduleDataPage,
} from './helpers/fixtures.js';

const REQUESTED_URL = 'https://www.lazada.sg/products/acme-mouse-i123.html';
const MODULE_HTML = moduleDataPage(MODULE_DATA_FIXTURE);
const PRODUCT_SLUG_URL = 'https://www.lazada.sg/products/blue-cotton-shirt-i123.html';
const PH_PRODUCT_URL = 'https://www.lazada.com.ph/products/acme-earbuds-i123.html';

function htmlOriginalPricePage(): string {
  return moduleDataPage({
    data: {
      root: {
        fields: {
          tracking: {
            pdt_name: 'HTML Earbuds',
            pdt_price: '₱13,990.00',
            brand_name: 'HTML Brand',
            pdt_photo: 'https://img.lazada.com/p/html-earbuds.jpg',
            core: { currencyCode: 'PHP' },
          },
        },
      },
    },
  });
}

function skuOnlyPage(pdtSku: unknown): string {
  return moduleDataPage({
    data: {
      root: {
        fields: {
          tracking: { pdt_sku: pdtSku },
        },
      },
    },
  });
}

function captureScrapeError(fn: () => unknown): ScrapeError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ScrapeError);
    return error as ScrapeError;
  }
  throw new Error('Expected the call to throw a ScrapeError.');
}

async function expectScrapeError(
  promise: Promise<unknown>,
  code: ScrapeErrorCode,
): Promise<ScrapeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ScrapeError);
    const scrapeError = error as ScrapeError;
    expect(scrapeError.code).toBe(code);
    expect(scrapeError.message.length).toBeGreaterThan(0);
    return scrapeError;
  }
  throw new Error(`Expected a ScrapeError with code ${code}.`);
}

describe('normalizeLazadaUrl', () => {
  it.each([
    [
      'https://www.lazada.sg/products/foo-i1.html',
      'https://www.lazada.sg/products/foo-i1.html',
      'SGD',
    ],
    [
      'https://www.lazada.com.my/products/foo-i1.html',
      'https://www.lazada.com.my/products/foo-i1.html',
      'MYR',
    ],
    [
      'https://www.lazada.co.th/products/foo-i1.html',
      'https://www.lazada.co.th/products/foo-i1.html',
      'THB',
    ],
    [
      'https://www.lazada.com.ph/products/foo-i1.html',
      'https://www.lazada.com.ph/products/foo-i1.html',
      'PHP',
    ],
    [
      'https://www.lazada.co.id/products/foo-i1.html',
      'https://www.lazada.co.id/products/foo-i1.html',
      'IDR',
    ],
    [
      'https://www.lazada.vn/products/foo-i1.html',
      'https://www.lazada.vn/products/foo-i1.html',
      'VND',
    ],
  ])('accepts marketplace %s', (input, expectedUrl, currency) => {
    const normalized = normalizeLazadaUrl(input);
    expect(normalized.url).toBe(expectedUrl);
    expect(normalized.marketplace.currency).toBe(currency);
    expect(normalized.isShare).toBe(false);
  });

  it.each([
    ['https://m.lazada.com.my/products/foo-i1.html', 'MYR'],
    ['https://s.lazada.co.th/products/foo-i1.html', 'THB'],
    ['https://www.lazada.co.id/products/foo-i1.html', 'IDR'],
  ])('accepts www/m/s subdomains for %s', (input, currency) => {
    const normalized = normalizeLazadaUrl(input);
    expect(normalized.url).toBe(input);
    expect(normalized.marketplace.currency).toBe(currency);
  });

  it('accepts a bare domain without the www subdomain', () => {
    const normalized = normalizeLazadaUrl('https://lazada.vn/products/foo-i1.html');
    expect(normalized.url).toBe('https://lazada.vn/products/foo-i1.html');
    expect(normalized.marketplace.currency).toBe('VND');
  });

  it('accepts scheme-less and protocol-relative input and upgrades to https', () => {
    expect(normalizeLazadaUrl('www.lazada.sg/products/foo-i1.html').url).toBe(
      'https://www.lazada.sg/products/foo-i1.html',
    );
    expect(normalizeLazadaUrl('m.lazada.com.ph/products/foo-i1.html').url).toBe(
      'https://m.lazada.com.ph/products/foo-i1.html',
    );
    expect(normalizeLazadaUrl('//www.lazada.co.id/products/foo-i1.html').url).toBe(
      'https://www.lazada.co.id/products/foo-i1.html',
    );
    expect(normalizeLazadaUrl('http://www.lazada.vn/products/foo-i1.html').url).toBe(
      'https://www.lazada.vn/products/foo-i1.html',
    );
  });

  it('strips query strings, fragments and surrounding whitespace', () => {
    const normalized = normalizeLazadaUrl(
      '  https://www.lazada.sg/products/foo-i1.html?spm=a1z.123&offer=1#reviews  ',
    );
    expect(normalized.url).toBe('https://www.lazada.sg/products/foo-i1.html');
    expect(normalized.hostname).toBe('www.lazada.sg');
    // Query parameters are dropped, not followed, so embedded URLs are inert.
    expect(
      normalizeLazadaUrl('https://www.lazada.sg/products/foo-i1.html?redirect=https://evil.com')
        .url,
    ).toBe('https://www.lazada.sg/products/foo-i1.html');
  });

  it('accepts explicit standard ports and drops them from the canonical URL', () => {
    expect(normalizeLazadaUrl('https://www.lazada.sg:443/products/foo-i1.html').url).toBe(
      'https://www.lazada.sg/products/foo-i1.html',
    );
    expect(normalizeLazadaUrl('http://www.lazada.sg:80/products/foo-i1.html').url).toBe(
      'https://www.lazada.sg/products/foo-i1.html',
    );
  });

  it('tolerates a trailing dot on the hostname', () => {
    expect(normalizeLazadaUrl('https://www.lazada.sg./products/foo-i1.html').url).toBe(
      'https://www.lazada.sg/products/foo-i1.html',
    );
  });

  it.each([
    ['https://www.lazada.sg/s/abc123', 'https://www.lazada.sg/s/abc123', 'SGD'],
    ['https://s.lazada.com.my/s/XYZ?share=1', 'https://s.lazada.com.my/s/XYZ', 'MYR'],
    ['https://www.lazada.co.th/s.abc123?foo=bar#section', 'https://www.lazada.co.th/s.abc123', 'THB'],
  ])('accepts lazada share links %s', (input, expectedUrl, currency) => {
    const normalized = normalizeLazadaUrl(input);
    expect(normalized.url).toBe(expectedUrl);
    expect(normalized.isShare).toBe(true);
    expect(normalized.marketplace.currency).toBe(currency);
  });

  it.each([
    '',
    '   ',
    'https://not-a-url.example',
    'https://www.shopee.sg/products/foo-i1.html',
    'https://lazy.lazada.evil.com/products/foo-i1.html',
    'https://lazada.sg.evil.com/products/foo-i1.html',
    'https://www.lazada.sg.evil.com/products/foo-i1.html',
    'https://evil.com/www.lazada.sg/products/foo-i1.html',
    'https://www.lazada.sg.evil.com/s/abc',
    'https://www.lazada.sg/',
    'https://www.lazada.sg/products/',
    'https://www.lazada.sg/products/foo-i1',
    'https://www.lazada.sg/products/foo-i1.html/',
    'https://www.lazada.sg/catalog/foo-i1.html',
    'https://user:pass@www.lazada.sg/products/foo-i1.html',
    'https://user@www.lazada.sg/products/foo-i1.html',
    'ftp://www.lazada.sg/products/foo-i1.html',
    'file:///tmp/foo.html',
    'https://www.lazada.sg:8443/products/foo-i1.html',
    'http://www.lazada.sg:8080/products/foo-i1.html',
  ])('rejects invalid URL %j', (input) => {
    const error = captureScrapeError(() => normalizeLazadaUrl(input));
    expect(error.code).toBe('INVALID_URL');
  });
});

describe('parsePrice', () => {
  it.each([
    ['$42.00', 42],
    ['RM 1,290.00', 1290],
    ['1.234,56', 1234.56],
    ['Rp 1.234.000', 1234000],
    ['฿1,290', 1290],
    ['1,290', 1290],
    ['42.5', 42.5],
    ['99', 99],
    ['1,234.56', 1234.56],
    ['1 290', 1290],
    ["1'290", 1290],
    ['S$129.90', 129.9],
  ])('parses display price %j as %d', (input, expected) => {
    expect(parsePrice(input)).toBe(expected);
  });

  it('treats exactly three digits after a single separator as a thousands group', () => {
    // Documented interpretation: "1,290" / "1.234" are thousands, not decimals.
    expect(parsePrice('1,290')).toBe(1290);
    expect(parsePrice('1.234')).toBe(1234);
    expect(parsePrice('12,345')).toBe(12345);
  });

  it.each([
    ['0', null],
    ['0.00', null],
    ['-42.00', null],
    ['-$42.00', null],
    ['Contact seller', null],
    ['free', null],
    ['', null],
    ['   ', null],
    ['n/a', null],
    [null, null],
    [undefined, null],
    [0, null],
    [-5, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
  ])('returns null for unusable price %j', (input, expected) => {
    expect(parsePrice(input)).toBe(expected);
  });

  it('passes finite positive numbers through', () => {
    expect(parsePrice(42.5)).toBe(42.5);
    expect(parsePrice(1234)).toBe(1234);
    expect(parsePrice(0.01)).toBe(0.01);
  });

  it.each([
    ['$-42.00', null],
    ['USD -5', null],
    ['−42.00', null],
    ['$-0.01', null],
    ['1.2345', 1.2345],
    ['1.234', 1234],
    ['$42.00', 42],
  ])('handles clarified price input %j as %j', (input, expected) => {
    expect(parsePrice(input)).toBe(expected);
  });
});

describe('parseLazadaHtml', () => {
  it('reads title, brand, price, currency and image from moduleData', () => {
    const parsed = parseLazadaHtml(
      moduleDataPage(MODULE_DATA_FIXTURE, {
        head: '<title>Wrong fallback | Lazada Singapore</title>',
      }),
      REQUESTED_URL,
    );

    expect(parsed).toMatchObject({
      title: 'Acme Wireless Mouse',
      brand: 'Acme',
      rating: null,
      reviewCount: null,
      currency: 'SGD',
      imageUrl: 'https://img.lazada.com/p/mouse-1.jpg',
      price: 42,
      priceText: 'S$42.00',
      sku: 'SKU-MOUSE-1',
      canonicalUrl: null,
    });
  });

  it('falls back to JSON-LD for metadata and ratings', () => {
    const parsed = parseLazadaHtml(jsonLdPage(JSON_LD_PRODUCT_FIXTURE), REQUESTED_URL);

    expect(parsed.title).toBe('JSON-LD Coffee Grinder');
    expect(parsed.brand).toBe('Grind Co');
    expect(parsed.price).toBe(129.9);
    expect(parsed.currency).toBe('SGD');
    expect(parsed.rating).toBe(4.6);
    expect(parsed.reviewCount).toBe(1234);
    expect(parsed.imageUrl).toBe('https://img.lazada.com/p/grinder-1.jpg');
    expect(parsed.canonicalUrl).toBe(
      'https://www.lazada.sg/products/coffee-grinder-i999.html',
    );
  });

  it.each([
    ['1.234', 1_234],
    ['1,234', 1_234],
    ['1 234', 1_234],
    ['1.2k', 1_200],
    ['2,5k', 2_500],
    ['1.234k', 1_234_000],
  ])('parses JSON-LD review count %j as %d', (reviewCount, expected) => {
    const parsed = parseLazadaHtml(
      jsonLdPage({
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Formatted Review Count',
        aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: '4.5',
          reviewCount,
        },
      }),
      REQUESTED_URL,
    );

    expect(parsed.reviewCount).toBe(expected);
  });

  it('falls back to Open Graph when moduleData is malformed', () => {
    const html = malformedModuleDataPage(
      [
        '<meta property="og:title" content="OG Product | Lazada Singapore">',
        '<meta property="og:image" content="//img.lazada.com/p/og.jpg">',
        '<title>Title Tag | Lazada Singapore</title>',
      ].join(''),
    );

    const parsed = parseLazadaHtml(html, REQUESTED_URL);
    expect(parsed.title).toBe('OG Product');
    expect(parsed.imageUrl).toBe('https://img.lazada.com/p/og.jpg');
    expect(parsed.price).toBeNull();
    expect(parsed.currency).toBe('SGD');
  });

  it('falls back to the title tag and strips the Lazada suffix when moduleData is absent', () => {
    const parsed = parseLazadaHtml(
      '<html><head><title>Plain Product | Lazada Singapore</title></head><body></body></html>',
      'https://www.lazada.vn/products/plain-product-i1.html',
    );
    expect(parsed.title).toBe('Plain Product');
    expect(parsed.currency).toBe('VND');
    expect(parsed.price).toBeNull();
  });

  it('derives a title from the URL slug when structured product evidence exists', () => {
    // A price is real structured product evidence, so the missing display name
    // may be filled in from the product slug.
    const html = moduleDataPage({
      data: {
        root: {
          fields: {
            tracking: {
              pdt_price: 'S$12.00',
            },
          },
        },
      },
    });

    const parsed = parseLazadaHtml(
      html,
      'https://www.lazada.sg/products/blue-cotton-shirt-i123.html',
    );
    expect(parsed.title).toBe('Blue cotton shirt');
    expect(parsed.price).toBe(12);
  });

  it('does not derive a title from the URL slug for an empty soft-404 page', () => {
    const parsed = parseLazadaHtml(
      '<html><head></head><body>empty shell</body></html>',
      'https://www.lazada.sg/products/blue-cotton-shirt-i123.html',
    );
    expect(parsed.title).toBeNull();
    expect(parsed.price).toBeNull();
  });

  it.each([
    ['empty string', ''],
    ['zero', 0],
  ])('does not treat a non-positive pdt_sku (%s) as structured evidence', (_label, pdtSku) => {
    const parsed = parseLazadaHtml(skuOnlyPage(pdtSku), PRODUCT_SLUG_URL);
    expect(parsed.title).toBeNull();
    expect(parsed.price).toBeNull();
  });

  it('derives the slug title when the only evidence is a positive numeric pdt_sku', () => {
    const parsed = parseLazadaHtml(skuOnlyPage(123), PRODUCT_SLUG_URL);
    expect(parsed.title).toBe('Blue cotton shirt');
    expect(parsed.price).toBeNull();
  });

  it('prefers a real tracking title over the URL slug', () => {
    const html = moduleDataPage({
      data: {
        root: {
          fields: {
            tracking: {
              pdt_name: 'Real Tracking Title',
              pdt_price: 'S$10.00',
              core: { currencyCode: 'SGD' },
            },
          },
        },
      },
    });

    const parsed = parseLazadaHtml(
      html,
      'https://www.lazada.sg/products/slug-title-i123.html',
    );
    expect(parsed.title).toBe('Real Tracking Title');
    expect(parsed.title).not.toBe('Slug title');
  });

  it('returns a null price when the embedded price text cannot be parsed', () => {
    const html = moduleDataPage({
      data: {
        root: {
          fields: {
            tracking: {
              pdt_price: 'Contact seller',
              pdt_name: 'Unpriced Item',
              brand_name: 'Acme',
              core: { currencyCode: 'SGD' },
            },
          },
        },
      },
    });

    const parsed = parseLazadaHtml(html, REQUESTED_URL);
    expect(parsed.title).toBe('Unpriced Item');
    expect(parsed.price).toBeNull();
    expect(parsed.priceText).toBe('Contact seller');
  });
});

describe('LazadaScraper', () => {
  it('fetches, parses and canonicalises a product page without a warning', async () => {
    const requestedUrls: string[] = [];
    let requestHeaders: Record<string, string> = {};
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch((url, init) => {
        requestedUrls.push(url);
        requestHeaders = init.headers as Record<string, string>;
        return fakeResponse(MODULE_HTML, {
          url: 'https://www.lazada.sg/products/acme-mouse-i123.html?spm=tracking',
        });
      }),
      timeoutMs: 1_000,
    });

    const result = await scraper.scrape(
      'https://www.lazada.sg/products/acme-mouse-i123.html?spm=source#top',
    );

    expect(requestedUrls).toEqual([REQUESTED_URL]);
    expect(requestHeaders['accept-language']).toBe('en-SG,en;q=0.9');
    expect(requestHeaders.referer).toBe('https://www.lazada.sg/');
    expect(requestHeaders['user-agent']).toMatch(/Mozilla\/5\.0/);

    expect(result.product).toMatchObject({
      url: REQUESTED_URL,
      title: 'Acme Wireless Mouse',
      brand: 'Acme',
      rating: null,
      reviewCount: null,
      currency: 'SGD',
      imageUrl: 'https://img.lazada.com/p/mouse-1.jpg',
      price: 42,
      sku: 'SKU-MOUSE-1',
    });
    expect(result.warning).toBeUndefined();
    expect('warning' in result).toBe(false);
  });

  it('resolves a share link to the canonical product URL after the redirect', async () => {
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() =>
        fakeResponse(MODULE_HTML, {
          url: 'https://www.lazada.sg/products/acme-mouse-i123.html?spm=share',
        }),
      ),
      timeoutMs: 1_000,
    });

    const result = await scraper.scrape('https://www.lazada.sg/s/abc123');

    expect(result.product.url).toBe(REQUESTED_URL);
    expect(result.product.title).toBe('Acme Wireless Mouse');
    expect(result.product.price).toBe(42);
  });

  it('returns metadata with a warning when the page has no price', async () => {    const html = moduleDataPage({
      data: {
        root: {
          fields: {
            tracking: {
              pdt_name: 'No Price Item',
              brand_name: 'Acme',
              core: { currencyCode: 'MYR' },
            },
          },
        },
      },
    });
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => fakeResponse(html)),
      timeoutMs: 1_000,
    });

    const result = await scraper.scrape(
      'https://www.lazada.com.my/products/no-price-i1.html',
    );

    expect(result.product.title).toBe('No Price Item');
    expect(result.product.brand).toBe('Acme');
    expect(result.product.currency).toBe('MYR');
    expect(result.product.price).toBeNull();
    expect(result.warning).toMatch(/Price unavailable/);
  });

  it('maps 404 and 410 responses to NOT_FOUND', async () => {
    for (const status of [404, 410]) {
      const scraper = new LazadaScraper({
        fetchImpl: stubFetch(() => fakeResponse('', { status })),
        timeoutMs: 1_000,
      });
      await expectScrapeError(scraper.scrape(REQUESTED_URL), 'NOT_FOUND');
    }
  });

  it('maps blocked HTTP statuses to BLOCKED', async () => {
    for (const status of [401, 403, 429, 451, 503]) {
      const scraper = new LazadaScraper({
        fetchImpl: stubFetch(() => fakeResponse('', { status })),
        timeoutMs: 1_000,
      });
      await expectScrapeError(scraper.scrape(REQUESTED_URL), 'BLOCKED');
    }
  });

  it('maps other non-OK responses to NETWORK', async () => {
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => fakeResponse('', { status: 500 })),
      timeoutMs: 1_000,
    });
    const error = await expectScrapeError(scraper.scrape(REQUESTED_URL), 'NETWORK');
    expect(error.message).toMatch(/HTTP 500/);
  });

  it('detects an anti-bot redirect in the final URL', async () => {
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() =>
        fakeResponse(MODULE_HTML, {
          url: 'https://www.lazada.sg/_____tmd_____/punish?x=1',
        }),
      ),
      timeoutMs: 1_000,
    });
    await expectScrapeError(scraper.scrape(REQUESTED_URL), 'BLOCKED');
  });

  it('detects an anti-bot challenge page in the HTML', async () => {
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() =>
        fakeResponse(
          '<html><head><title>Access Denied</title></head><body>no access</body></html>',
        ),
      ),
      timeoutMs: 1_000,
    });
    await expectScrapeError(scraper.scrape(REQUESTED_URL), 'BLOCKED');
  });

  it('rejects a non-HTML content type with PARSE', async () => {
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() =>
        fakeResponse('{"not":"html"}', { contentType: 'application/json' }),
      ),
      timeoutMs: 1_000,
    });
    await expectScrapeError(scraper.scrape(REQUESTED_URL), 'PARSE');
  });

  it('rejects a page without any title with PARSE', async () => {
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => fakeResponse('<html><body>empty shell</body></html>')),
      timeoutMs: 1_000,
    });
    // A share URL has no product slug, so the URL-based title fallback cannot
    // rescue an untitled page.
    await expectScrapeError(scraper.scrape('https://www.lazada.sg/s/abc123'), 'PARSE');
  });

  it('rejects an empty soft-404 page at a product URL with PARSE', async () => {
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() =>
        fakeResponse('<html><head></head><body>empty shell</body></html>'),
      ),
      timeoutMs: 1_000,
    });

    await expectScrapeError(scraper.scrape(REQUESTED_URL), 'PARSE');
  });

  it.each([
    ['empty string', ''],
    ['zero', 0],
  ])('rejects a page whose only evidence is a non-positive pdt_sku (%s) with PARSE', async (_label, pdtSku) => {
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => fakeResponse(skuOnlyPage(pdtSku))),
      timeoutMs: 1_000,
    });

    await expectScrapeError(scraper.scrape(PRODUCT_SLUG_URL), 'PARSE');
  });

  it('uses the slug title when the only structured evidence is a positive numeric pdt_sku', async () => {
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => fakeResponse(skuOnlyPage(123))),
      timeoutMs: 1_000,
    });

    const result = await scraper.scrape(PRODUCT_SLUG_URL);

    expect(result.product.title).toBe('Blue cotton shirt');
    expect(result.product.price).toBeNull();
    expect(result.warning).toMatch(/Price unavailable/);
  });

  it('rejects non-Lazada URLs before making a request', async () => {
    let calls = 0;
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => {
        calls += 1;
        return fakeResponse(MODULE_HTML);
      }),
      timeoutMs: 1_000,
    });

    await expectScrapeError(
      scraper.scrape('https://www.shopee.sg/products/foo-i1.html'),
      'INVALID_URL',
    );
    expect(calls).toBe(0);
  });

  it('maps transport failures to NETWORK', async () => {
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => {
        throw new TypeError('fetch failed');
      }),
      timeoutMs: 1_000,
    });
    const error = await expectScrapeError(scraper.scrape(REQUESTED_URL), 'NETWORK');
    expect(error.message).toMatch(/Could not reach Lazada/);
  });

  it('maps aborts to a readable timeout NETWORK error', async () => {
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => {
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        throw abort;
      }),
      timeoutMs: 1_000,
    });
    const error = await expectScrapeError(scraper.scrape(REQUESTED_URL), 'NETWORK');
    expect(error.message).toMatch(/took too long/);
  });
});

describe('LazadaScraper with a renderer', () => {
  it('uses the renderer product without fetching HTML when it supplies a title', async () => {
    let fetchCalls = 0;
    const renderer = new FakeRenderer(() =>
      makeRenderedProduct({
        url: PH_PRODUCT_URL,
        title: 'Rendered Earbuds',
        brand: 'Acme',
        rating: 5,
        reviewCount: 62,
        price: 3_000,
        currency: 'PHP',
        imageUrl: 'https://img.lazada.com/p/rendered-earbuds.jpg',
        sku: 'sku-red',
      }),
    );
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => {
        fetchCalls += 1;
        return fakeResponse(htmlOriginalPricePage());
      }),
      renderer,
      timeoutMs: 1_000,
    });

    const result = await scraper.scrape(PH_PRODUCT_URL);

    expect(fetchCalls).toBe(0);
    expect(renderer.requests).toHaveLength(1);
    expect(result.product).toMatchObject({
      url: PH_PRODUCT_URL,
      title: 'Rendered Earbuds',
      brand: 'Acme',
      rating: 5,
      reviewCount: 62,
      price: 3_000,
      currency: 'PHP',
      imageUrl: 'https://img.lazada.com/p/rendered-earbuds.jpg',
      sku: 'sku-red',
    });
    expect(result.warning).toBeUndefined();
  });

  it('keeps the renderer price over the HTML original price when HTML is fetched', async () => {
    let fetchCalls = 0;
    const renderer = new FakeRenderer(() =>
      makeRenderedProduct({
        url: null,
        title: null,
        brand: null,
        rating: null,
        reviewCount: null,
        price: 3_000,
        currency: 'PHP',
        imageUrl: null,
        sku: null,
      }),
    );
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => {
        fetchCalls += 1;
        return fakeResponse(htmlOriginalPricePage());
      }),
      renderer,
      timeoutMs: 1_000,
    });

    const result = await scraper.scrape(PH_PRODUCT_URL);

    // No renderer title forces the metadata HTML fallback.
    expect(fetchCalls).toBe(1);
    expect(result.product.title).toBe('HTML Earbuds');
    expect(result.product.brand).toBe('HTML Brand');
    expect(result.product.price).toBe(3_000);
    expect(result.product.price).not.toBe(13_990);
    expect(result.warning).toBeUndefined();
  });

  it('falls back to HTML metadata but no price when the renderer throws', async () => {
    let fetchCalls = 0;
    const renderer = new FakeRenderer(() => {
      throw new Error('renderer failed');
    });
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => {
        fetchCalls += 1;
        return fakeResponse(htmlOriginalPricePage());
      }),
      renderer,
      timeoutMs: 1_000,
    });

    const result = await scraper.scrape(PH_PRODUCT_URL);

    expect(fetchCalls).toBe(1);
    expect(result.product.title).toBe('HTML Earbuds');
    expect(result.product.brand).toBe('HTML Brand');
    expect(result.product.price).toBeNull();
    expect(result.product.price).not.toBe(13_990);
    expect(result.warning).toBe(DISPLAYED_PRICE_UNAVAILABLE_WARNING);
  });

  it('never fetches HTML directly when the renderer uses proxies', async () => {
    let fetchCalls = 0;
    const renderer = new FakeRenderer(
      () => {
        throw new Error('every proxy failed');
      },
      { usesProxy: true },
    );
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => {
        fetchCalls += 1;
        return fakeResponse(htmlOriginalPricePage());
      }),
      renderer,
      timeoutMs: 1_000,
    });

    await expect(scraper.scrape(PH_PRODUCT_URL)).rejects.toThrow('every proxy failed');
    expect(fetchCalls).toBe(0);
  });

  it('surfaces a proxy cooldown as BLOCKED without fetching HTML', async () => {
    let fetchCalls = 0;
    const blockedUntil = Date.now() + 3 * 60 * 60 * 1000;
    const renderer = new FakeRenderer(
      () => {
        throw new RenderBlockedError('Pausing checks for 3 hours.', blockedUntil);
      },
      { usesProxy: true },
    );
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => {
        fetchCalls += 1;
        return fakeResponse(htmlOriginalPricePage());
      }),
      renderer,
      timeoutMs: 1_000,
    });

    const error = await expectScrapeError(scraper.scrape(PH_PRODUCT_URL), 'BLOCKED');
    expect(error.message).toMatch(/3 hours/);
    expect(fetchCalls).toBe(0);
  });

  it('does not fall back to the HTML price when the renderer has a title but no price', async () => {
    let fetchCalls = 0;
    const renderer = new FakeRenderer(() =>
      makeRenderedProduct({
        url: null,
        title: 'Rendered Earbuds',
        price: null,
      }),
    );
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => {
        fetchCalls += 1;
        return fakeResponse(htmlOriginalPricePage());
      }),
      renderer,
      timeoutMs: 1_000,
    });

    const result = await scraper.scrape(PH_PRODUCT_URL);

    expect(fetchCalls).toBe(0);
    expect(result.product.title).toBe('Rendered Earbuds');
    expect(result.product.price).toBeNull();
    expect(result.warning).toBe(DISPLAYED_PRICE_UNAVAILABLE_WARNING);
  });

  it('passes the marketplace locale and timezone to the renderer', async () => {
    const renderer = new FakeRenderer(() =>
      makeRenderedProduct({ url: null, title: 'Rendered Earbuds' }),
    );
    const scraper = new LazadaScraper({ renderer, timeoutMs: 1_000 });

    await scraper.scrape(PH_PRODUCT_URL);

    expect(renderer.requests).toEqual([
      {
        url: PH_PRODUCT_URL,
        locale: 'en-PH',
        timezoneId: 'Asia/Manila',
      },
    ]);
  });

  it('closes the renderer', async () => {
    const renderer = new FakeRenderer();
    const scraper = new LazadaScraper({ renderer });

    await scraper.close();

    expect(renderer.closeCalls).toBe(1);
  });

  it('keeps the HTML-only price behavior when no renderer is configured', async () => {
    const scraper = new LazadaScraper({
      fetchImpl: stubFetch(() => fakeResponse(htmlOriginalPricePage())),
      timeoutMs: 1_000,
    });

    const result = await scraper.scrape(PH_PRODUCT_URL);

    expect(result.product.price).toBe(13_990);
    expect(result.warning).toBeUndefined();
  });
});
