import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../db.js';
import { ConflictError, ScrapeError } from '../errors.js';
import { DISPLAYED_PRICE_UNAVAILABLE_WARNING } from '../scraper.js';
import {
  PRICE_UNAVAILABLE_WARNING,
  ProductService,
} from '../service.js';
import {
  DEFAULT_PRODUCT_URL,
  FakeScraper,
  createClock,
  makeScrapedProduct,
  silentLogger,
} from './helpers/fakes.js';
import type { TestClock } from './helpers/fakes.js';

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
      title: url,
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

describe('ProductService', () => {
  let db: AppDatabase;
  let scraper: FakeScraper;
  let service: ProductService;
  let clock: TestClock;

  beforeEach(() => {
    db = new AppDatabase(':memory:');
    scraper = new FakeScraper();
    clock = createClock();
    service = new ProductService(db, scraper, {
      staggerMs: 0,
      now: clock.now,
      logger: silentLogger,
    });
  });

  afterEach(() => {
    service.stop();
    db.close();
  });

  describe('addProduct', () => {
    it('stores metadata plus the initial price and returns a one-point DTO', async () => {
      const result = await service.addProduct(
        'www.lazada.sg/products/test-product-i123.html?spm=tracking#top',
      );

      expect(result.warning).toBeUndefined();
      expect(scraper.calls).toEqual([DEFAULT_PRODUCT_URL]);

      const product = result.product;
      expect(product).toMatchObject({
        url: DEFAULT_PRODUCT_URL,
        title: 'Test Product',
        brand: 'Test Brand',
        rating: 4.5,
        reviewCount: 42,
        currency: 'SGD',
        imageUrl: 'https://img.lazada.com/test.jpg',
        createdAt: clock.iso(),
        lastCheckedAt: clock.iso(),
        lastError: null,
        currentPrice: 100,
        previousPrice: null,
        priceChange: null,
        dropPercent: 0,
        lowestPrice: 100,
        highestPrice: 100,
      });
      expect(product.history).toEqual([{ price: 100, recordedAt: clock.iso() }]);
      expect(db.countProducts()).toBe(1);
      expect(db.getPriceRecords(product.id)).toHaveLength(1);
    });

    it('stores metadata without a price and warns when the page has no price', async () => {
      scraper.handler = () => ({
        product: makeScrapedProduct({
          price: null,
          rating: null,
          reviewCount: null,
        }),
      });

      const result = await service.addProduct(DEFAULT_PRODUCT_URL);

      expect(result.warning).toBe(PRICE_UNAVAILABLE_WARNING);
      expect(result.product).toMatchObject({
        title: 'Test Product',
        brand: 'Test Brand',
        currentPrice: null,
        previousPrice: null,
        priceChange: null,
        dropPercent: 0,
        lowestPrice: null,
        highestPrice: null,
        lastError: PRICE_UNAVAILABLE_WARNING,
        lastCheckedAt: clock.iso(),
      });
      expect(result.product.history).toEqual([]);
      expect(db.getPriceRecords(result.product.id)).toEqual([]);
    });

    it('stores the scraper warning as lastError when the price is unavailable', async () => {
      scraper.handler = () => ({
        product: makeScrapedProduct({ price: null }),
        warning: DISPLAYED_PRICE_UNAVAILABLE_WARNING,
      });

      const result = await service.addProduct(DEFAULT_PRODUCT_URL);

      expect(result.warning).toBe(DISPLAYED_PRICE_UNAVAILABLE_WARNING);
      expect(result.product.lastError).toBe(DISPLAYED_PRICE_UNAVAILABLE_WARNING);
      expect(result.product.currentPrice).toBeNull();
      expect(result.product.history).toEqual([]);
    });

    it('clears lastError after a later successful refresh records a price', async () => {
      scraper.handler = () => ({
        product: makeScrapedProduct({ price: null }),
      });
      const created = await service.addProduct(DEFAULT_PRODUCT_URL);
      expect(created.product.lastError).toBe(PRICE_UNAVAILABLE_WARNING);
      expect(created.product.history).toEqual([]);

      clock.advance(60_000);
      scraper.handler = () => ({
        product: makeScrapedProduct({ price: 80 }),
      });

      const refreshed = await service.refreshProduct(created.product.id);

      expect(refreshed).not.toBeNull();
      expect(refreshed?.warning).toBeUndefined();
      expect(refreshed?.product).toMatchObject({
        currentPrice: 80,
        lastError: null,
        lastCheckedAt: clock.iso(),
      });
      expect(refreshed?.product.history.map((point) => point.price)).toEqual([80]);
    });

    it('passes a scraper warning through even when a price was read', async () => {
      scraper.handler = () => ({
        product: makeScrapedProduct({ price: 55 }),
        warning: 'Partial metadata only',
      });

      const result = await service.addProduct(DEFAULT_PRODUCT_URL);

      expect(result.warning).toBe('Partial metadata only');
      expect(result.product.currentPrice).toBe(55);
      expect(result.product.history).toHaveLength(1);
    });

    it('rejects a duplicate normalized URL without creating rows', async () => {
      const first = await service.addProduct(DEFAULT_PRODUCT_URL);

      await expect(
        service.addProduct('https://www.lazada.sg/products/test-product-i123.html?spm=again'),
      ).rejects.toBeInstanceOf(ConflictError);

      expect(db.countProducts()).toBe(1);
      expect(db.getPriceRecords(first.product.id)).toHaveLength(1);
      // The duplicate guard runs before the network/scrape phase.
      expect(scraper.calls).toHaveLength(1);
    });

    it('propagates a ScrapeError from the scraper without persisting anything', async () => {
      const failure = new ScrapeError('NOT_FOUND', 'That product is gone.');
      scraper.handler = () => {
        throw failure;
      };

      await expect(service.addProduct(DEFAULT_PRODUCT_URL)).rejects.toBe(failure);
      expect(db.countProducts()).toBe(0);
    });

    it('stores the canonical URL resolved by the scraper', async () => {
      scraper.handler = () => ({
        product: makeScrapedProduct({
          url: 'https://www.lazada.sg/products/canonical-product-i777.html',
        }),
      });

      const result = await service.addProduct('https://www.lazada.sg/s/share123');

      expect(result.product.url).toBe(
        'https://www.lazada.sg/products/canonical-product-i777.html',
      );
      expect(scraper.calls).toEqual(['https://www.lazada.sg/s/share123']);
    });

    it('wraps unexpected scraper failures as NETWORK ScrapeErrors', async () => {      scraper.handler = () => {
        throw new TypeError('boom');
      };

      const error = await service.addProduct(DEFAULT_PRODUCT_URL).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ScrapeError);
      expect((error as ScrapeError).code).toBe('NETWORK');
      expect((error as ScrapeError).cause).toBeInstanceOf(TypeError);
      expect(db.countProducts()).toBe(0);
    });
  });

  describe('owner scoping', () => {
    it('defaults to owner 0 and scopes rows and operations by owner', async () => {
      const first = await service.addProduct(DEFAULT_PRODUCT_URL);
      expect(db.getProduct(first.product.id)?.userId).toBe(0);
      expect(service.listProducts().map((product) => product.id)).toEqual([
        first.product.id,
      ]);

      const second = await service.addProduct(DEFAULT_PRODUCT_URL, 1);
      expect(second.product.id).not.toBe(first.product.id);
      expect(db.getProduct(second.product.id)?.userId).toBe(1);
      expect(service.listProducts(1).map((product) => product.id)).toEqual([
        second.product.id,
      ]);

      expect(await service.refreshProduct(first.product.id, 1)).toBeNull();
      expect(service.deleteProduct(first.product.id, 1)).toBe(false);
      expect(service.deleteProduct(second.product.id, 1)).toBe(true);
      expect(service.deleteProduct(first.product.id, 0)).toBe(true);
      expect(db.countProducts()).toBe(0);
    });
  });

  describe('deleteProduct', () => {
    it('returns false for unknown ids and cascades price records for real ones', async () => {
      expect(service.deleteProduct(999)).toBe(false);

      const created = await service.addProduct(DEFAULT_PRODUCT_URL);
      const id = created.product.id;
      expect(db.getPriceRecords(id)).toHaveLength(1);

      expect(service.deleteProduct(id)).toBe(true);
      expect(db.getProduct(id)).toBeNull();
      expect(db.getPriceRecords(id)).toEqual([]);
      expect(db.getPriceSummary(id)).toEqual({
        history: [],
        currentPrice: null,
        previousPrice: null,
        lowestPrice: null,
        highestPrice: null,
      });

      expect(service.deleteProduct(id)).toBe(false);
    });
  });

  describe('refreshProduct', () => {
    it('updates metadata, appends a price point and reports a drop', async () => {
      const created = await service.addProduct(DEFAULT_PRODUCT_URL);
      const id = created.product.id;

      clock.advance(60_000);
      scraper.handler = () => ({
        product: makeScrapedProduct({
          title: 'Updated Test Product',
          brand: 'New Brand',
          rating: 4.8,
          reviewCount: 12,
          imageUrl: 'https://img.lazada.com/test-2.jpg',
          price: 90,
        }),
      });

      const refreshed = await service.refreshProduct(id);
      expect(refreshed).not.toBeNull();

      const product = refreshed?.product;
      expect(product).toMatchObject({
        id,
        title: 'Updated Test Product',
        brand: 'New Brand',
        rating: 4.8,
        reviewCount: 12,
        imageUrl: 'https://img.lazada.com/test-2.jpg',
        lastCheckedAt: clock.iso(),
        lastError: null,
        currentPrice: 90,
        previousPrice: 100,
        priceChange: -10,
        dropPercent: 10,
        lowestPrice: 90,
        highestPrice: 100,
      });
      expect(product?.history.map((point) => point.price)).toEqual([100, 90]);
      expect(refreshed?.warning).toBeUndefined();
    });

    it('returns null for a missing product without calling the scraper', async () => {
      expect(await service.refreshProduct(4242)).toBeNull();
      expect(scraper.calls).toEqual([]);
    });

    it('propagates a scrape failure, records lastError and keeps the saved price', async () => {
      const created = await service.addProduct(DEFAULT_PRODUCT_URL);
      const id = created.product.id;

      clock.advance(60_000);
      scraper.handler = () => {
        throw new ScrapeError('BLOCKED', 'blocked by anti-bot');
      };

      await expect(service.refreshProduct(id)).rejects.toMatchObject({
        name: 'ScrapeError',
        code: 'BLOCKED',
        message: 'blocked by anti-bot',
      });

      const products = service.listProducts();
      expect(products).toHaveLength(1);
      const product = products[0];
      expect(product).toBeDefined();
      expect(product?.currentPrice).toBe(100);
      expect(product?.history).toHaveLength(1);
      expect(product?.lastError).toBe('blocked by anti-bot');
      expect(product?.lastCheckedAt).toBe(clock.iso());
      expect(product?.title).toBe('Test Product');
    });

    it('truncates very long scrape errors stored as lastError', async () => {
      const created = await service.addProduct(DEFAULT_PRODUCT_URL);
      const id = created.product.id;

      scraper.handler = () => {
        throw new Error('x'.repeat(600));
      };
      await expect(service.refreshProduct(id)).rejects.toBeInstanceOf(Error);

      const product = service.listProducts()[0];
      expect(product?.lastError).toHaveLength(500);
      expect(product?.lastError?.endsWith('…')).toBe(true);
    });
  });

  describe('DTO price semantics and ordering', () => {
    it('uses the most recent differing earlier price and sorts by dropPercent then id', () => {
      const idA = seedPrices(db, 'https://www.lazada.sg/products/a-i1.html', [120, 100, 100]);
      const idB = seedPrices(db, 'https://www.lazada.sg/products/b-i1.html', [100, 110]);
      const idC = seedPrices(db, 'https://www.lazada.sg/products/c-i1.html', [50, 50]);
      const idD = seedPrices(db, 'https://www.lazada.sg/products/d-i1.html', [
        100, 90, 90, 95, 95,
      ]);
      const idE = seedPrices(db, 'https://www.lazada.sg/products/e-i1.html', [70]);

      const products = service.listProducts();
      expect(products.map((product) => product.id)).toEqual([idA, idC, idE, idD, idB]);

      const byId = new Map(products.map((product) => [product.id, product]));

      const a = byId.get(idA);
      expect(a).toMatchObject({
        currentPrice: 100,
        previousPrice: 120,
        priceChange: -20,
        dropPercent: 16.67,
        lowestPrice: 100,
        highestPrice: 120,
      });
      expect(a?.history.map((point) => point.price)).toEqual([120, 100, 100]);

      const b = byId.get(idB);
      expect(b).toMatchObject({
        currentPrice: 110,
        previousPrice: 100,
        priceChange: 10,
        dropPercent: -10,
      });

      const c = byId.get(idC);
      expect(c).toMatchObject({
        currentPrice: 50,
        previousPrice: null,
        priceChange: null,
        dropPercent: 0,
      });

      // current 95; the most recent earlier *different* price is 90, not 100.
      const d = byId.get(idD);
      expect(d).toMatchObject({
        currentPrice: 95,
        previousPrice: 90,
        priceChange: 5,
        dropPercent: -5.56,
        lowestPrice: 90,
        highestPrice: 100,
      });
      expect(d?.history.map((point) => point.price)).toEqual([100, 90, 90, 95, 95]);
      const recordedTimes = (d?.history ?? []).map((point) => Date.parse(point.recordedAt));
      expect(recordedTimes).toEqual([...recordedTimes].sort((left, right) => left - right));

      const e = byId.get(idE);
      expect(e).toMatchObject({
        currentPrice: 70,
        previousPrice: null,
        priceChange: null,
        dropPercent: 0,
      });
    });

    it('caps history at 500 points while min/max use the full history', () => {
      const prices = Array.from({ length: 505 }, (_, index) => 100 + index);
      const id = seedPrices(db, 'https://www.lazada.sg/products/long-i1.html', prices);

      const products = service.listProducts();
      expect(products).toHaveLength(1);
      const product = products[0];
      expect(product?.id).toBe(id);
      expect(product?.history).toHaveLength(500);
      expect(product?.history[0]?.price).toBe(105);
      expect(product?.history[499]?.price).toBe(604);
      expect(product?.history[0]?.recordedAt).toBe(
        new Date(Date.UTC(2026, 0, 1) + 5_000).toISOString(),
      );
      expect(product?.currentPrice).toBe(604);
      expect(product?.previousPrice).toBe(603);
      expect(product?.lowestPrice).toBe(100);
      expect(product?.highestPrice).toBe(604);
    });

    it('finds a differing previous price even when it predates the 500-point history window', () => {
      const prices = [100, ...Array.from({ length: 504 }, () => 50)];
      const id = seedPrices(db, 'https://www.lazada.sg/products/old-i1.html', prices);

      const products = service.listProducts();
      expect(products).toHaveLength(1);
      const product = products[0];
      expect(product?.id).toBe(id);
      expect(product?.history).toHaveLength(500);
      expect(product?.history.every((point) => point.price === 50)).toBe(true);
      expect(product?.previousPrice).toBe(100);
      expect(product?.dropPercent).toBe(50);
      expect(product?.lowestPrice).toBe(50);
      expect(product?.highestPrice).toBe(100);
    });
  });

  describe('settings', () => {
    it('reads the configured interval from the database', () => {
      expect(service.getSettings()).toEqual({ trackingIntervalSeconds: 300 });
    });
  });
});
