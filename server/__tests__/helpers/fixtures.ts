/**
 * Self-contained Lazada-like HTML fixtures. Nothing here performs network I/O;
 * the shapes mirror the data the scraper documents in docs/api-contract.md.
 */

export interface ModuleDataFixture {
  data: {
    root: {
      fields: {
        tracking: {
          pdt_price: string;
          pdt_name: string;
          brand_name: string;
          pdt_photo: string;
          pdt_sku: string;
          core: { currencyCode: string };
          [key: string]: unknown;
        };
        product: {
          title: string;
          skuId: string;
          [key: string]: unknown;
        };
        [key: string]: unknown;
      };
    };
  };
}

export const MODULE_DATA_FIXTURE: ModuleDataFixture = {
  data: {
    root: {
      fields: {
        tracking: {
          pdt_price: 'S$42.00',
          pdt_name: 'Acme Wireless Mouse',
          brand_name: 'Acme',
          pdt_photo: '//img.lazada.com/p/mouse-1.jpg',
          pdt_sku: 'SKU-MOUSE-1',
          core: { currencyCode: 'SGD' },
        },
        product: {
          title: 'Acme Wireless Mouse (product field, lower priority)',
          skuId: 'SKU-MOUSE-1',
        },
      },
    },
  },
};

export interface JsonLdFixture {
  '@context': string;
  '@type': string;
  name: string;
  brand: { name: string };
  offers: {
    '@type': string;
    price: string;
    priceCurrency: string;
  };
  aggregateRating: {
    '@type': string;
    ratingValue: string;
    reviewCount: string;
  };
  image: string[];
  url: string;
}

export const JSON_LD_PRODUCT_FIXTURE: JsonLdFixture = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'JSON-LD Coffee Grinder | Lazada Singapore',
  brand: { name: 'Grind Co' },
  offers: {
    '@type': 'Offer',
    price: '129.90',
    priceCurrency: 'SGD',
  },
  aggregateRating: {
    '@type': 'AggregateRating',
    ratingValue: '4.6',
    reviewCount: '1,234',
  },
  image: ['https://img.lazada.com/p/grinder-1.jpg'],
  url: 'https://www.lazada.sg/products/coffee-grinder-i999.html?spm=tracking',
};

/** Page whose only product data lives in the `__moduleData__` script. */
export function moduleDataPage(
  moduleData: unknown,
  options: { head?: string; body?: string } = {},
): string {
  return `<!doctype html>
<html>
  <head>${options.head ?? ''}</head>
  <body>
    <script>window.__moduleData__ = ${JSON.stringify(moduleData)};</script>
    ${options.body ?? ''}
  </body>
</html>`;
}

/** Page whose product data lives in a JSON-LD Product block. */
export function jsonLdPage(jsonLd: unknown, options: { head?: string } = {}): string {
  return `<!doctype html>
<html>
  <head>
    ${options.head ?? ''}
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  </head>
  <body><div id="root"></div></body>
</html>`;
}

/** Page with an unparseable module assignment so fallbacks must be used. */
export function malformedModuleDataPage(head: string): string {
  return `<!doctype html>
<html>
  <head>${head}</head>
  <body>
    <script>window.__moduleData__ = {this is not valid json</script>
  </body>
</html>`;
}
