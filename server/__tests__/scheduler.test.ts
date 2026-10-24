import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../db.js';
import { ScrapeError } from '../errors.js';
import { ProductService, PRICE_UNAVAILABLE_WARNING } from '../service.js';
import {
  DEFAULT_PRODUCT_URL,
  FakeScraper,
  makeScrapedProduct,
  silentLogger,
} from './helpers/fakes.js';

const DEFAULT_INTERVAL_MS = 300_000;

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  // Let the fire-and-forget scheduled check settle its promise chain.
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
  await vi.advanceTimersByTimeAsync(0);
}

describe('ProductService scheduler', () => {
  let db: AppDatabase;
  let scraper: FakeScraper;
  let service: ProductService;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new AppDatabase(':memory:');
    scraper = new FakeScraper();
    service = new ProductService(db, scraper, {
      staggerMs: 0,
      logger: silentLogger,
    });
  });

  afterEach(() => {
    service.stop();
    db.close();
    vi.useRealTimers();
  });

  it('creates no timers and performs no checks before start()', async () => {
    const created = await service.addProduct(DEFAULT_PRODUCT_URL);

    expect(scraper.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    await advance(DEFAULT_INTERVAL_MS * 2);

    expect(scraper.calls).toHaveLength(1);
    expect(db.getPriceRecords(created.product.id)).toHaveLength(1);
  });

  it('schedules the first automatic check only after the configured interval', async () => {
    const created = await service.addProduct(DEFAULT_PRODUCT_URL);
    const id = created.product.id;

    expect(service.getSettings().trackingIntervalSeconds).toBe(300);
    service.start();
    expect(vi.getTimerCount()).toBe(1);

    await advance(DEFAULT_INTERVAL_MS - 1);
    expect(scraper.calls).toHaveLength(1);
    expect(db.getPriceRecords(id)).toHaveLength(1);

    await advance(1);
    expect(scraper.calls).toHaveLength(2);
    expect(db.getPriceRecords(id)).toHaveLength(2);

    // The loop keeps running after the first check.
    await advance(DEFAULT_INTERVAL_MS);
    expect(scraper.calls).toHaveLength(3);
    expect(db.getPriceRecords(id)).toHaveLength(3);
  });

  it('schedules a timer for a product added while the service is running', async () => {
    service.start();
    expect(vi.getTimerCount()).toBe(0);

    const created = await service.addProduct(DEFAULT_PRODUCT_URL);
    expect(vi.getTimerCount()).toBe(1);

    await advance(DEFAULT_INTERVAL_MS);
    expect(scraper.calls).toHaveLength(2);
    expect(db.getPriceRecords(created.product.id)).toHaveLength(2);
  });

  it('cancels the timer when a product is deleted', async () => {
    const created = await service.addProduct(DEFAULT_PRODUCT_URL);
    const id = created.product.id;

    service.start();
    await advance(10_000);
    expect(service.deleteProduct(id)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await advance(DEFAULT_INTERVAL_MS * 2);

    expect(scraper.calls).toHaveLength(1);
    expect(db.countProducts()).toBe(0);
  });

  it('stop() prevents any further checks', async () => {
    const created = await service.addProduct(DEFAULT_PRODUCT_URL);

    service.start();
    await advance(DEFAULT_INTERVAL_MS);
    expect(scraper.calls).toHaveLength(2);
    expect(db.getPriceRecords(created.product.id)).toHaveLength(2);

    service.stop();
    expect(vi.getTimerCount()).toBe(0);

    await advance(DEFAULT_INTERVAL_MS * 3);
    expect(scraper.calls).toHaveLength(2);
    expect(db.getPriceRecords(created.product.id)).toHaveLength(2);
  });

  it('records a rejected check as lastError and recovers on the next tick', async () => {
    const created = await service.addProduct(DEFAULT_PRODUCT_URL);
    const id = created.product.id;

    scraper.handler = () => {
      throw new ScrapeError('BLOCKED', 'scheduler blocked');
    };
    service.start();

    await advance(DEFAULT_INTERVAL_MS);
    expect(scraper.calls).toHaveLength(2);

    let product = service.listProducts()[0];
    expect(product?.id).toBe(id);
    expect(product?.lastError).toBe('scheduler blocked');
    expect(product?.currentPrice).toBe(100);
    expect(product?.history).toHaveLength(1);

    scraper.handler = () => ({ product: makeScrapedProduct({ price: 80 }) });

    await advance(DEFAULT_INTERVAL_MS);
    expect(scraper.calls).toHaveLength(3);

    product = service.listProducts()[0];
    expect(product?.lastError).toBeNull();
    expect(product?.currentPrice).toBe(80);
    expect(product?.previousPrice).toBe(100);
    expect(product?.dropPercent).toBe(20);
    expect(product?.history.map((point) => point.price)).toEqual([100, 80]);
  });

  it('records no price point and sets lastError for a price-unavailable check, then clears it', async () => {
    const created = await service.addProduct(DEFAULT_PRODUCT_URL);
    const id = created.product.id;

    scraper.handler = () => ({ product: makeScrapedProduct({ price: null }) });
    service.start();

    await advance(DEFAULT_INTERVAL_MS);
    expect(scraper.calls).toHaveLength(2);

    let product = service.listProducts()[0];
    expect(product?.id).toBe(id);
    expect(product?.lastError).toBe(PRICE_UNAVAILABLE_WARNING);
    expect(product?.currentPrice).toBe(100);
    expect(product?.history).toHaveLength(1);

    scraper.handler = () => ({ product: makeScrapedProduct({ price: 80 }) });

    await advance(DEFAULT_INTERVAL_MS);
    expect(scraper.calls).toHaveLength(3);

    product = service.listProducts()[0];
    expect(product?.lastError).toBeNull();
    expect(product?.currentPrice).toBe(80);
    expect(product?.history.map((point) => point.price)).toEqual([100, 80]);
  });

  it('runs background checks for products owned by different accounts', async () => {
    const owner0 = await service.addProduct(DEFAULT_PRODUCT_URL, 0);
    const owner1 = await service.addProduct(DEFAULT_PRODUCT_URL, 1);
    expect(scraper.calls).toHaveLength(2);

    service.start();
    expect(vi.getTimerCount()).toBe(2);

    await advance(DEFAULT_INTERVAL_MS);

    expect(scraper.calls).toHaveLength(4);
    expect(db.getPriceRecords(owner0.product.id)).toHaveLength(2);
    expect(db.getPriceRecords(owner1.product.id)).toHaveLength(2);
    expect(service.listProducts(0)).toHaveLength(1);
    expect(service.listProducts(1)).toHaveLength(1);
  });
});
