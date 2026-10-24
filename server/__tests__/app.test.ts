import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { AppDatabase } from '../db.js';
import { ScrapeError } from '../errors.js';
import { ProductService } from '../service.js';
import {
  DEFAULT_PRODUCT_URL,
  FakeScraper,
  makeScrapedProduct,
  silentLogger,
} from './helpers/fakes.js';

const PRODUCT_KEYS = [
  'id',
  'url',
  'title',
  'brand',
  'rating',
  'reviewCount',
  'currency',
  'imageUrl',
  'createdAt',
  'lastCheckedAt',
  'lastError',
  'currentPrice',
  'previousPrice',
  'priceChange',
  'dropPercent',
  'lowestPrice',
  'highestPrice',
  'history',
].sort();

function expectProductShape(product: Record<string, unknown>): void {
  expect(Object.keys(product).sort()).toEqual(PRODUCT_KEYS);
  expect(typeof product.id).toBe('number');
  expect(typeof product.url).toBe('string');
  expect(typeof product.title).toBe('string');
  expect(typeof product.currency).toBe('string');
  expect(typeof product.dropPercent).toBe('number');
  expect(Array.isArray(product.history)).toBe(true);
  for (const point of product.history as Array<Record<string, unknown>>) {
    expect(Object.keys(point).sort()).toEqual(['price', 'recordedAt']);
    expect(typeof point.price).toBe('number');
    expect(typeof point.recordedAt).toBe('string');
  }
}

function seedPrices(
  db: AppDatabase,
  url: string,
  prices: number[],
  startMs = Date.UTC(2026, 0, 1),
): number {
  const firstPrice = prices[0];
  if (firstPrice === undefined) throw new Error('seedPrices requires at least one price');

  const row = db.createProduct(
    {
      url,
      title: `Seeded ${url}`,
      currency: 'SGD',
      createdAt: new Date(startMs).toISOString(),
    },
    firstPrice,
  );
  for (let index = 1; index < prices.length; index += 1) {
    const price = prices[index];
    if (price === undefined) continue;
    db.addPrice(row.id, price, new Date(startMs + index * 1_000).toISOString());
  }
  return row.id;
}

describe('HTTP API', () => {
  let db: AppDatabase;
  let scraper: FakeScraper;
  let service: ProductService;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new AppDatabase(':memory:');
    scraper = new FakeScraper();
    service = new ProductService(db, scraper, {
      staggerMs: 0,
      logger: silentLogger,
    });
    app = createApp({ service });
  });

  afterEach(() => {
    service.stop();
    db.close();
  });

  it('GET /api/health returns ok', async () => {
    const response = await request(app).get('/api/health').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /api/products is empty and GET /api/settings defaults to 300', async () => {
    const products = await request(app).get('/api/products').expect(200);
    expect(products.body).toEqual({ products: [] });

    const settings = await request(app).get('/api/settings').expect(200);
    expect(settings.body).toEqual({ trackingIntervalSeconds: 300 });
  });

  describe('POST /api/products validation', () => {
    it.each([
      ['missing url', {}],
      ['empty url', { url: '' }],
      ['blank url', { url: '   ' }],
      ['non-string url (number)', { url: 42 }],
      ['non-string url (array)', { url: ['https://www.lazada.sg/products/x-i1.html'] }],
      ['non-string url (object)', { url: { href: 'x' } }],
      [
        'too-long url',
        { url: `https://www.lazada.sg/products/${'a'.repeat(2_049)}.html` },
      ],
    ])('rejects %s with 400', async (_label, body) => {
      const response = await request(app).post('/api/products').send(body).expect(400);
      expect(response.body).toEqual({ error: expect.any(String) });
      expect(scraper.calls).toHaveLength(0);
    });

    it('rejects a request without a body with 400', async () => {
      const response = await request(app).post('/api/products').expect(400);
      expect(response.body).toEqual({ error: expect.any(String) });
    });

    it('rejects malformed JSON with a 400 JSON error', async () => {
      const response = await request(app)
        .post('/api/products')
        .set('Content-Type', 'application/json')
        .send('{"url":')
        .expect(400);
      expect(response.body).toEqual({ error: expect.stringMatching(/valid JSON/i) });
    });

    it('rejects a non-Lazada URL with 400 before scraping', async () => {
      const response = await request(app)
        .post('/api/products')
        .send({ url: 'https://www.shopee.sg/products/foo-i1.html' })
        .expect(400);
      expect(response.body.error).toMatch(/Lazada/i);
      expect(scraper.calls).toHaveLength(0);
    });
  });

  describe('POST /api/products behavior', () => {
    it('creates a product with its initial history point', async () => {
      const response = await request(app)
        .post('/api/products')
        .send({ url: 'www.lazada.sg/products/test-product-i123.html?spm=x' })
        .expect(201);

      expect(response.body.warning).toBeUndefined();
      expectProductShape(response.body.product);
      expect(response.body.product).toMatchObject({
        url: DEFAULT_PRODUCT_URL,
        title: 'Test Product',
        brand: 'Test Brand',
        currentPrice: 100,
        previousPrice: null,
        priceChange: null,
        dropPercent: 0,
        lowestPrice: 100,
        highestPrice: 100,
        lastError: null,
      });
      expect(response.body.product.history).toHaveLength(1);
      expect(response.body.product.history[0].price).toBe(100);
      expect(scraper.calls).toEqual([DEFAULT_PRODUCT_URL]);
    });

    it('returns 409 for a duplicate normalized URL', async () => {
      await request(app)
        .post('/api/products')
        .send({ url: DEFAULT_PRODUCT_URL })
        .expect(201);

      const response = await request(app)
        .post('/api/products')
        .send({ url: 'https://www.lazada.sg/products/test-product-i123.html?spm=dup' })
        .expect(409);

      expect(response.body).toEqual({ error: expect.any(String) });
      expect(db.countProducts()).toBe(1);
    });

    it('returns 422 when Lazada blocks the scrape', async () => {
      scraper.handler = () => {
        throw new ScrapeError('BLOCKED', 'Lazada blocked this request.');
      };

      const response = await request(app)
        .post('/api/products')
        .send({ url: DEFAULT_PRODUCT_URL })
        .expect(422);
      expect(response.body).toEqual({ error: 'Lazada blocked this request.' });
      expect(db.countProducts()).toBe(0);
    });

    it('returns 201 with a warning when the price is unavailable', async () => {
      scraper.handler = () => ({
        product: makeScrapedProduct({ price: null }),
      });

      const response = await request(app)
        .post('/api/products')
        .send({ url: DEFAULT_PRODUCT_URL })
        .expect(201);

      expect(response.body.warning).toMatch(/Price unavailable/);
      expectProductShape(response.body.product);
      expect(response.body.product.currentPrice).toBeNull();
      expect(response.body.product.history).toEqual([]);
      expect(response.body.product.lowestPrice).toBeNull();
      expect(response.body.product.highestPrice).toBeNull();
      expect(response.body.product.lastError).toBe(response.body.warning);
    });

    it('clears lastError after a later successful refresh records a price', async () => {
      scraper.handler = () => ({
        product: makeScrapedProduct({ price: null }),
      });
      const created = await request(app)
        .post('/api/products')
        .send({ url: DEFAULT_PRODUCT_URL })
        .expect(201);
      const id = created.body.product.id as number;
      expect(created.body.product.lastError).toBe(created.body.warning);

      scraper.handler = () => ({
        product: makeScrapedProduct({ price: 3_000 }),
      });

      const refreshed = await request(app)
        .post(`/api/products/${id}/refresh`)
        .expect(200);

      expectProductShape(refreshed.body.product);
      expect(refreshed.body.warning).toBeUndefined();
      expect(refreshed.body.product.currentPrice).toBe(3_000);
      expect(refreshed.body.product.lastError).toBeNull();
      expect(refreshed.body.product.history).toHaveLength(1);
      expect(refreshed.body.product.history[0].price).toBe(3_000);
    });
  });

  describe('GET /api/products', () => {
    it('returns complete, sorted DTOs', async () => {
      const idA = seedPrices(db, 'https://www.lazada.sg/products/a-i1.html', [120, 100, 100]);
      const idB = seedPrices(db, 'https://www.lazada.sg/products/b-i1.html', [100, 110]);
      const idC = seedPrices(db, 'https://www.lazada.sg/products/c-i1.html', [50]);

      const response = await request(app).get('/api/products').expect(200);
      const products = response.body.products as Array<Record<string, unknown>>;

      expect(products.map((product) => product.id)).toEqual([idA, idC, idB]);
      expectProductShape(products[0] as Record<string, unknown>);
      expect(products[0]).toMatchObject({
        id: idA,
        currentPrice: 100,
        previousPrice: 120,
        priceChange: -20,
        dropPercent: 16.67,
        lowestPrice: 100,
        highestPrice: 120,
      });
      expect(products[1]).toMatchObject({
        id: idC,
        currentPrice: 50,
        previousPrice: null,
        priceChange: null,
        dropPercent: 0,
      });
      expect(products[2]).toMatchObject({
        id: idB,
        currentPrice: 110,
        previousPrice: 100,
        priceChange: 10,
        dropPercent: -10,
      });
      expect(products[0]?.history).toHaveLength(3);
    });
  });

  describe('DELETE /api/products/:id', () => {
    it('returns 404 for an unknown product', async () => {
      const response = await request(app).delete('/api/products/999').expect(404);
      expect(response.body).toEqual({ error: 'Product not found.' });
    });

    it('returns 400 for a malformed id', async () => {
      const response = await request(app).delete('/api/products/abc').expect(400);
      expect(response.body).toEqual({ error: expect.any(String) });
    });

    it('deletes an existing product and removes it from subsequent listings', async () => {
      const created = await request(app)
        .post('/api/products')
        .send({ url: DEFAULT_PRODUCT_URL })
        .expect(201);
      const id = created.body.product.id as number;

      const deleted = await request(app).delete(`/api/products/${id}`).expect(204);
      expect(deleted.text).toBe('');

      const list = await request(app).get('/api/products').expect(200);
      expect(list.body).toEqual({ products: [] });
      expect(db.getProduct(id)).toBeNull();
      expect(db.getPriceRecords(id)).toEqual([]);
    });
  });

  describe('POST /api/products/:id/refresh', () => {
    it('returns the updated product with a new history point', async () => {
      const created = await request(app)
        .post('/api/products')
        .send({ url: DEFAULT_PRODUCT_URL })
        .expect(201);
      const id = created.body.product.id as number;

      scraper.handler = () => ({
        product: makeScrapedProduct({ price: 90, title: 'Refreshed Title' }),
      });

      const response = await request(app)
        .post(`/api/products/${id}/refresh`)
        .expect(200);

      expectProductShape(response.body.product);
      expect(response.body.product).toMatchObject({
        id,
        title: 'Refreshed Title',
        currentPrice: 90,
        previousPrice: 100,
        priceChange: -10,
        dropPercent: 10,
        lowestPrice: 90,
        highestPrice: 100,
      });
      expect(response.body.product.history).toHaveLength(2);
      expect(response.body.product.history.map((point: { price: number }) => point.price)).toEqual([
        100, 90,
      ]);
    });

    it('returns 404 for an unknown product', async () => {
      const response = await request(app).post('/api/products/999/refresh').expect(404);
      expect(response.body).toEqual({ error: 'Product not found.' });
      expect(scraper.calls).toHaveLength(0);
    });

    it('returns 422 when the refresh scrape fails', async () => {
      const created = await request(app)
        .post('/api/products')
        .send({ url: DEFAULT_PRODUCT_URL })
        .expect(201);
      const id = created.body.product.id as number;

      scraper.handler = () => {
        throw new ScrapeError('NETWORK', 'network down');
      };

      const response = await request(app)
        .post(`/api/products/${id}/refresh`)
        .expect(422);
      expect(response.body).toEqual({ error: 'network down' });

      const list = await request(app).get('/api/products').expect(200);
      expect(list.body.products).toHaveLength(1);
      expect(list.body.products[0].currentPrice).toBe(100);
      expect(list.body.products[0].lastError).toBe('network down');
    });
  });

  describe('settings', () => {
    it('GET reads the configured interval', async () => {
      const get = await request(app).get('/api/settings').expect(200);
      expect(get.body).toEqual({ trackingIntervalSeconds: 300 });
    });

    it('does not expose a settings update endpoint', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({ trackingIntervalSeconds: 60 })
        .expect(404);
      expect(response.body).toEqual({ error: 'API route not found.' });
    });
  });

  describe('404 handling', () => {
    it('returns JSON for unknown API routes', async () => {
      const response = await request(app).get('/api/nope').expect(404);
      expect(response.body).toEqual({ error: 'API route not found.' });
    });

    it('returns JSON for unknown non-API routes when no client is configured', async () => {
      const response = await request(app).get('/definitely/not/a/route').expect(404);
      expect(response.body).toEqual({ error: 'Not found.' });
    });
  });

  it('rejects request bodies over 32kb with 413', async () => {
    const response = await request(app)
      .post('/api/products')
      .send({ url: 'x'.repeat(40_000) })
      .expect(413);
    expect(response.body).toEqual({ error: expect.stringMatching(/too large/i) });
    expect(scraper.calls).toHaveLength(0);
  });

  it('serves the SPA shell for client routes while keeping API 404s as JSON', async () => {
    const clientDir = mkdtempSync(path.join(tmpdir(), 'lazada-spa-'));
    try {
      writeFileSync(
        path.join(clientDir, 'index.html'),
        '<!doctype html><html><body><div id="spa-marker">SPA shell</div></body></html>',
      );
      const spaApp = createApp({ service, clientDir });

      const page = await request(spaApp).get('/some/client/route').expect(200);
      expect(page.headers['content-type']).toMatch(/text\/html/);
      expect(page.text).toContain('spa-marker');

      const root = await request(spaApp).get('/').expect(200);
      expect(root.text).toContain('spa-marker');

      const api = await request(spaApp).get('/api/nope').expect(404);
      expect(api.body).toEqual({ error: 'API route not found.' });
    } finally {
      rmSync(clientDir, { recursive: true, force: true });
    }
  });

  describe('single-user compatibility', () => {
    it('reports the single-user session and disables auth endpoints', async () => {
      const session = await request(app).get('/api/auth/session').expect(200);
      expect(session.body).toEqual({
        multiUser: false,
        authenticated: true,
        user: null,
      });

      await request(app)
        .post('/api/auth/register')
        .send({
          email: 'alice@example.com',
          password: 'secret',
          confirmPassword: 'secret',
        })
        .expect(404);
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'alice@example.com', password: 'secret' })
        .expect(404);
    });

    it('keeps product and settings endpoints accessible without cookies', async () => {
      const products = await request(app).get('/api/products').expect(200);
      expect(products.body).toEqual({ products: [] });

      const settings = await request(app).get('/api/settings').expect(200);
      expect(settings.body).toEqual({ trackingIntervalSeconds: 300 });

      const created = await request(app)
        .post('/api/products')
        .send({ url: DEFAULT_PRODUCT_URL })
        .expect(201);
      expect(created.body.product.url).toBe(DEFAULT_PRODUCT_URL);
    });
  });
});
