import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../db.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lazentinel-migration-'));
  tempDirs.push(dir);
  return path.join(dir, 'legacy.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const LEGACY_URL = 'https://www.lazada.sg/products/legacy-product-i1.html';

function createLegacyDatabase(file: string): void {
  const db = new Database(file);
  try {
    db.exec(`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        brand TEXT,
        rating REAL,
        review_count INTEGER,
        currency TEXT NOT NULL,
        image_url TEXT,
        created_at TEXT NOT NULL,
        last_checked_at TEXT,
        last_error TEXT
      );

      CREATE TABLE price_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        price REAL NOT NULL CHECK (price > 0),
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX idx_price_records_product_recorded
        ON price_records (product_id, recorded_at, id);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO products (
        url, title, brand, rating, review_count, currency, image_url,
        created_at, last_checked_at, last_error
      ) VALUES (
        '${LEGACY_URL}', 'Legacy Product', 'Legacy Brand', 4.5, 9, 'SGD',
        'https://img.lazada.com/legacy.jpg',
        '2025-12-01T00:00:00.000Z', '2025-12-02T00:00:00.000Z', NULL
      );

      INSERT INTO price_records (product_id, price, recorded_at)
      VALUES (1, 42.5, '2025-12-01T00:00:00.000Z');

      INSERT INTO settings (key, value) VALUES ('trackingIntervalSeconds', '120');
    `);
  } finally {
    db.close();
  }
}

describe('v2 product database migration', () => {
  it('preserves legacy products and prices under owner 0 and adds composite ownership', () => {
    const file = tempDbPath();
    createLegacyDatabase(file);

    const db = new AppDatabase(file);
    try {
      const legacy = db.getProduct(1);
      expect(legacy).not.toBeNull();
      expect(legacy).toMatchObject({
        id: 1,
        userId: 0,
        url: LEGACY_URL,
        title: 'Legacy Product',
        brand: 'Legacy Brand',
        rating: 4.5,
        reviewCount: 9,
        currency: 'SGD',
        imageUrl: 'https://img.lazada.com/legacy.jpg',
        createdAt: '2025-12-01T00:00:00.000Z',
        lastCheckedAt: '2025-12-02T00:00:00.000Z',
      });
      expect(db.getPriceRecords(1)).toEqual([
        { price: 42.5, recordedAt: '2025-12-01T00:00:00.000Z' },
      ]);
      expect(db.getSettings()).toEqual({ trackingIntervalSeconds: 300 });
      expect(db.countProducts()).toBe(1);
      expect(db.listProducts(0)).toHaveLength(1);
      expect(db.listProducts(1)).toEqual([]);

      // The legacy global URL uniqueness must be gone: owner 0 may not duplicate
      // its own URL, but owner 1 may track the same product independently.
      expect(() =>
        db.createProduct(
          { url: LEGACY_URL, title: 'Duplicate Owner 0', currency: 'SGD' },
          undefined,
          0,
        ),
      ).toThrow();

      const secondOwner = db.createProduct(
        { url: LEGACY_URL, title: 'Owner 1 Copy', currency: 'SGD' },
        99,
        1,
      );
      expect(secondOwner.userId).toBe(1);
      expect(secondOwner.url).toBe(LEGACY_URL);
      expect(secondOwner.id).not.toBe(1);
      expect(db.listProducts(0).map((row) => row.id)).toEqual([1]);
      expect(db.listProducts(1).map((row) => row.id)).toEqual([secondOwner.id]);
      expect(db.getPriceRecords(secondOwner.id)).toEqual([
        { price: 99, recordedAt: expect.any(String) },
      ]);

      // Foreign keys remain valid after the table rebuild: deleting the legacy
      // product must cascade its price record.
      expect(db.deleteProduct(1)).toBe(true);
      expect(db.getPriceRecords(1)).toEqual([]);
      expect(db.getProduct(secondOwner.id)).not.toBeNull();
    } finally {
      db.close();
    }

    const raw = new Database(file, { readonly: true });
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(2);
    } finally {
      raw.close();
    }
  });
});

describe('startup tracking interval', () => {
  it('applies the provided interval to a new database', () => {
    const file = tempDbPath();
    const db = new AppDatabase(file, { trackingIntervalSeconds: 900 });
    try {
      expect(db.getSettings()).toEqual({ trackingIntervalSeconds: 900 });
    } finally {
      db.close();
    }
  });

  it('overwrites an existing saved interval with the startup value', () => {
    const file = tempDbPath();
    const first = new AppDatabase(file, { trackingIntervalSeconds: 60 });
    first.setSettings({ trackingIntervalSeconds: 120 });
    first.close();

    const second = new AppDatabase(file, { trackingIntervalSeconds: 600 });
    try {
      expect(second.getSettings()).toEqual({ trackingIntervalSeconds: 600 });
    } finally {
      second.close();
    }
  });
});
