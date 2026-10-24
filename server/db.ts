import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_TRACKING_INTERVAL_SECONDS, isValidTrackingInterval } from './config.js';

export interface ProductRow {
  id: number;
  userId: number;
  url: string;
  title: string;
  brand: string | null;
  rating: number | null;
  reviewCount: number | null;
  currency: string;
  imageUrl: string | null;
  createdAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface PricePoint {
  price: number;
  recordedAt: string;
}

export interface ProductMetadata {
  title?: string | null;
  brand?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  imageUrl?: string | null;
}

export interface CreateProductInput extends ProductMetadata {
  url: string;
  title: string;
  currency: string;
  createdAt?: string;
}

export interface RecordCheckInput {
  checkedAt: string;
  price?: number | null;
  metadata?: ProductMetadata;
  error?: string | null;
}

export interface PriceSummary {
  /** Up to `limit` points, oldest first. */
  history: PricePoint[];
  currentPrice: number | null;
  /** Most recent earlier price that differs from currentPrice. */
  previousPrice: number | null;
  lowestPrice: number | null;
  highestPrice: number | null;
}

export interface Settings {
  trackingIntervalSeconds: number;
}

export interface AppDatabaseOptions {
  /** Tracking interval to apply on startup. Overwrites any saved value. */
  trackingIntervalSeconds?: number;
}

interface SettingsRow {
  value: string;
}

interface PriceRangeRow {
  lowest: number | null;
  highest: number | null;
}

const SCHEMA_VERSION = 2;

const PRODUCT_COLUMNS = `
  id,
  user_id AS userId,
  url,
  title,
  brand,
  rating,
  review_count AS reviewCount,
  currency,
  image_url AS imageUrl,
  created_at AS createdAt,
  last_checked_at AS lastCheckedAt,
  last_error AS lastError
`;

const PRODUCT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 0,
    url TEXT NOT NULL,
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
`;

const SUPPORTING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS price_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price REAL NOT NULL CHECK (price > 0),
    recorded_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_price_records_product_recorded
    ON price_records (product_id, recorded_at, id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const PRODUCT_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_products_owner_url
    ON products (user_id, url);

  CREATE INDEX IF NOT EXISTS idx_products_owner
    ON products (user_id);
`;

/**
 * Small synchronous wrapper around better-sqlite3. All SQL is prepared and
 * parameterised; multi-write operations are wrapped in transactions.
 */
export class AppDatabase {
  private readonly sqlite: Database.Database;
  private readonly trackingIntervalSeconds: number;

  private readonly insertProductStmt: Database.Statement<
    {
      userId: number;
      url: string;
      title: string;
      brand: string | null;
      rating: number | null;
      reviewCount: number | null;
      currency: string;
      imageUrl: string | null;
      createdAt: string;
    },
    unknown
  >;

  private readonly selectProductByIdStmt: Database.Statement<[number], ProductRow>;
  private readonly selectProductByUrlStmt: Database.Statement<
    [number, string],
    ProductRow
  >;
  private readonly selectProductsByOwnerStmt: Database.Statement<[number], ProductRow>;
  private readonly selectAllProductsStmt: Database.Statement<[], ProductRow>;
  private readonly selectProductIdsStmt: Database.Statement<[], { id: number }>;
  private readonly deleteProductByIdStmt: Database.Statement<[number], unknown>;
  private readonly deleteProductForOwnerStmt: Database.Statement<
    [number, number],
    unknown
  >;
  private readonly deleteProductByUrlStmt: Database.Statement<[number, string], unknown>;

  private readonly updateMetadataStmt: Database.Statement<
    {
      id: number;
      title: string | null;
      brand: string | null;
      rating: number | null;
      reviewCount: number | null;
      imageUrl: string | null;
    },
    unknown
  >;

  private readonly updateCheckStmt: Database.Statement<
    {
      id: number;
      checkedAt: string;
      lastError: string | null;
      title: string | null;
      brand: string | null;
      rating: number | null;
      reviewCount: number | null;
      imageUrl: string | null;
    },
    unknown
  >;

  private readonly insertPriceStmt: Database.Statement<
    { productId: number; price: number; recordedAt: string },
    unknown
  >;
  private readonly selectPricesStmt: Database.Statement<[number], PricePoint>;
  private readonly selectRecentPricesStmt: Database.Statement<
    { productId: number; limit: number },
    PricePoint
  >;
  private readonly selectLatestPriceStmt: Database.Statement<[number], { price: number }>;
  private readonly selectPreviousDifferentPriceStmt: Database.Statement<
    { productId: number; currentPrice: number },
    { price: number }
  >;
  private readonly selectPriceRangeStmt: Database.Statement<[number], PriceRangeRow>;

  private readonly selectSettingStmt: Database.Statement<[string], SettingsRow>;
  private readonly selectSettingsStmt: Database.Statement<[], { key: string; value: string }>;
  private readonly upsertSettingStmt: Database.Statement<{ key: string; value: string }, unknown>;

  constructor(databasePath: string, options: AppDatabaseOptions = {}) {
    this.trackingIntervalSeconds =
      options.trackingIntervalSeconds !== undefined &&
      isValidTrackingInterval(options.trackingIntervalSeconds)
        ? options.trackingIntervalSeconds
        : DEFAULT_TRACKING_INTERVAL_SECONDS;

    if (databasePath !== ':memory:') {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    this.sqlite = new Database(databasePath);
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    if (databasePath !== ':memory:') {
      this.sqlite.pragma('journal_mode = WAL');
      this.sqlite.pragma('synchronous = NORMAL');
    }
    this.initializeSchema();
    // The interval is configured only through TRACKING_INTERVAL_MINUTES, so the
    // startup value is authoritative and overwrites any previously stored one.
    this.sqlite
      .prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(
        'trackingIntervalSeconds',
        String(this.trackingIntervalSeconds),
      );

    this.insertProductStmt = this.sqlite.prepare(`
      INSERT INTO products (user_id, url, title, brand, rating, review_count, currency, image_url, created_at)
      VALUES (@userId, @url, @title, @brand, @rating, @reviewCount, @currency, @imageUrl, @createdAt)
    `);
    this.selectProductByIdStmt = this.sqlite.prepare<[number], ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`,
    );
    this.selectProductByUrlStmt = this.sqlite.prepare<[number, string], ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE user_id = ? AND url = ?`,
    );
    this.selectProductsByOwnerStmt = this.sqlite.prepare<[number], ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE user_id = ? ORDER BY id ASC`,
    );
    this.selectAllProductsStmt = this.sqlite.prepare<[], ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products ORDER BY id ASC`,
    );
    this.selectProductIdsStmt = this.sqlite.prepare<[], { id: number }>(
      'SELECT id FROM products ORDER BY id ASC',
    );
    this.deleteProductByIdStmt = this.sqlite.prepare<[number], unknown>(
      'DELETE FROM products WHERE id = ?',
    );
    this.deleteProductForOwnerStmt = this.sqlite.prepare<[number, number], unknown>(
      'DELETE FROM products WHERE id = ? AND user_id = ?',
    );
    this.deleteProductByUrlStmt = this.sqlite.prepare<[number, string], unknown>(
      'DELETE FROM products WHERE user_id = ? AND url = ?',
    );
    this.updateMetadataStmt = this.sqlite.prepare(`
      UPDATE products SET
        title = COALESCE(@title, title),
        brand = COALESCE(@brand, brand),
        rating = COALESCE(@rating, rating),
        review_count = COALESCE(@reviewCount, review_count),
        image_url = COALESCE(@imageUrl, image_url)
      WHERE id = @id
    `);
    this.updateCheckStmt = this.sqlite.prepare(`
      UPDATE products SET
        last_checked_at = @checkedAt,
        last_error = @lastError,
        title = COALESCE(@title, title),
        brand = COALESCE(@brand, brand),
        rating = COALESCE(@rating, rating),
        review_count = COALESCE(@reviewCount, review_count),
        image_url = COALESCE(@imageUrl, image_url)
      WHERE id = @id
    `);
    this.insertPriceStmt = this.sqlite.prepare(`
      INSERT INTO price_records (product_id, price, recorded_at)
      VALUES (@productId, @price, @recordedAt)
    `);
    this.selectPricesStmt = this.sqlite.prepare<[number], PricePoint>(
      `SELECT price, recorded_at AS recordedAt
       FROM price_records
       WHERE product_id = ?
       ORDER BY recorded_at ASC, id ASC`,
    );
    this.selectRecentPricesStmt = this.sqlite.prepare<
      { productId: number; limit: number },
      PricePoint
    >(
      `SELECT price, recorded_at AS recordedAt
       FROM price_records
       WHERE product_id = @productId
       ORDER BY recorded_at DESC, id DESC
       LIMIT @limit`,
    );
    this.selectLatestPriceStmt = this.sqlite.prepare<[number], { price: number }>(
      `SELECT price
       FROM price_records
       WHERE product_id = ?
       ORDER BY recorded_at DESC, id DESC
       LIMIT 1`,
    );
    this.selectPreviousDifferentPriceStmt = this.sqlite.prepare<
      { productId: number; currentPrice: number },
      { price: number }
    >(
      `SELECT price
       FROM price_records
       WHERE product_id = @productId
         AND price <> @currentPrice
       ORDER BY recorded_at DESC, id DESC
       LIMIT 1`,
    );
    this.selectPriceRangeStmt = this.sqlite.prepare<[number], PriceRangeRow>(
      `SELECT MIN(price) AS lowest, MAX(price) AS highest
       FROM price_records
       WHERE product_id = ?`,
    );
    this.selectSettingStmt = this.sqlite.prepare<[string], SettingsRow>(
      'SELECT value FROM settings WHERE key = ?',
    );
    this.selectSettingsStmt = this.sqlite.prepare<[], { key: string; value: string }>(
      'SELECT key, value FROM settings',
    );
    this.upsertSettingStmt = this.sqlite.prepare(`
      INSERT INTO settings (key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
  }

  /**
   * Creates or upgrades the product database. Version 2 introduces per-user
   * ownership and replaces the old global URL uniqueness with a composite
   * (user_id, url) index. Existing products are preserved with owner 0.
   */
  private initializeSchema(): void {
    const productsTable = this.sqlite
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'products'",
      )
      .get();

    if (!productsTable) {
      this.sqlite.exec(PRODUCT_SCHEMA + SUPPORTING_SCHEMA + PRODUCT_INDEXES);
      this.sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
      return;
    }

    this.sqlite.exec(SUPPORTING_SCHEMA);
    const version = Number(this.sqlite.pragma('user_version', { simple: true })) || 0;
    const columns = this.sqlite
      .prepare<[], { name: string }>('PRAGMA table_info(products)')
      .all();
    const hasUserId = columns.some((column) => column.name === 'user_id');
    const tableDefinition = this.sqlite
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'",
      )
      .get();
    const hasLegacyUniqueUrl =
      tableDefinition !== undefined &&
      /url\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(tableDefinition.sql);

    if (!hasUserId || hasLegacyUniqueUrl) {
      this.rebuildProductsForOwnership(hasUserId);
    }

    this.sqlite.exec(PRODUCT_INDEXES);
    if (version < SCHEMA_VERSION) {
      this.sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
    }

    const violations = this.sqlite.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error(
        'Product database migration produced foreign key violations. Please back up and inspect the database.',
      );
    }
  }

  private rebuildProductsForOwnership(hasUserId: boolean): void {
    const userExpression = hasUserId ? 'user_id' : '0';
    const createProductsNew = PRODUCT_SCHEMA.replace(
      'CREATE TABLE IF NOT EXISTS products',
      'DROP TABLE IF EXISTS products_new;\n    CREATE TABLE products_new',
    );

    this.sqlite.pragma('foreign_keys = OFF');
    try {
      const migrate = this.sqlite.transaction(() => {
        this.sqlite.exec(`
          ${createProductsNew}
          INSERT INTO products_new (
            id, user_id, url, title, brand, rating, review_count, currency,
            image_url, created_at, last_checked_at, last_error
          )
          SELECT
            id, ${userExpression}, url, title, brand, rating, review_count,
            currency, image_url, created_at, last_checked_at, last_error
          FROM products;
          DROP TABLE products;
          ALTER TABLE products_new RENAME TO products;
        `);
      });
      migrate();
    } finally {
      this.sqlite.pragma('foreign_keys = ON');
    }
  }

  now(): string {
    return new Date().toISOString();
  }

  createProduct(
    input: CreateProductInput,
    initialPrice?: number | null,
    ownerId = 0,
  ): ProductRow {
    const userId = this.assertOwnerId(ownerId);
    const createdAt = input.createdAt ?? this.now();
    const create = this.sqlite.transaction(() => {
      const result = this.insertProductStmt.run({
        userId,
        url: input.url,
        title: input.title,
        brand: input.brand ?? null,
        rating: input.rating ?? null,
        reviewCount: input.reviewCount ?? null,
        currency: input.currency,
        imageUrl: input.imageUrl ?? null,
        createdAt,
      });
      const id = Number(result.lastInsertRowid);
      if (initialPrice !== undefined && initialPrice !== null && initialPrice > 0) {
        this.insertPriceStmt.run({ productId: id, price: initialPrice, recordedAt: createdAt });
      }
      return this.requireProduct(id);
    });
    return create();
  }

  getProduct(id: number): ProductRow | null {
    return this.selectProductByIdStmt.get(id) ?? null;
  }

  getProductByUrl(url: string, ownerId = 0): ProductRow | null {
    return this.selectProductByUrlStmt.get(this.assertOwnerId(ownerId), url) ?? null;
  }

  listProducts(ownerId = 0): ProductRow[] {
    return this.selectProductsByOwnerStmt.all(this.assertOwnerId(ownerId));
  }

  listAllProducts(): ProductRow[] {
    return this.selectAllProductsStmt.all();
  }

  countProducts(): number {
    const row = this.sqlite
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM products')
      .get();
    return row?.count ?? 0;
  }

  getProductIds(): number[] {
    return this.selectProductIdsStmt.all().map((row) => row.id);
  }

  deleteProduct(id: number): boolean {
    return this.deleteProductByIdStmt.run(id).changes > 0;
  }

  deleteProductForOwner(id: number, ownerId: number): boolean {
    return (
      this.deleteProductForOwnerStmt.run(id, this.assertOwnerId(ownerId)).changes > 0
    );
  }

  deleteProductByUrl(url: string, ownerId = 0): boolean {
    return (
      this.deleteProductByUrlStmt.run(this.assertOwnerId(ownerId), url).changes > 0
    );
  }

  private assertOwnerId(ownerId: number): number {
    if (!Number.isSafeInteger(ownerId) || ownerId < 0) {
      throw new Error(`Invalid product owner id: ${ownerId}`);
    }
    return ownerId;
  }

  updateProductMetadata(id: number, metadata: ProductMetadata): void {
    this.updateMetadataStmt.run({
      id,
      title: metadata.title ?? null,
      brand: metadata.brand ?? null,
      rating: metadata.rating ?? null,
      reviewCount: metadata.reviewCount ?? null,
      imageUrl: metadata.imageUrl ?? null,
    });
  }

  addPrice(productId: number, price: number, recordedAt: string = this.now()): void {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Cannot record a non-positive price (${price}).`);
    }
    this.insertPriceStmt.run({ productId, price, recordedAt });
  }

  /**
   * Persists the outcome of one check. Metadata is only overwritten when a
   * non-null value is supplied; a supplied `null` means "no information".
   */
  recordCheck(id: number, input: RecordCheckInput): void {
    const metadata = input.metadata ?? {};
    const record = this.sqlite.transaction(() => {
      this.updateCheckStmt.run({
        id,
        checkedAt: input.checkedAt,
        lastError: input.error ?? null,
        title: metadata.title ?? null,
        brand: metadata.brand ?? null,
        rating: metadata.rating ?? null,
        reviewCount: metadata.reviewCount ?? null,
        imageUrl: metadata.imageUrl ?? null,
      });
      const price = input.price;
      if (price !== undefined && price !== null && price > 0) {
        this.insertPriceStmt.run({
          productId: id,
          price,
          recordedAt: input.checkedAt,
        });
      }
    });
    record();
  }

  getPriceRecords(productId: number): PricePoint[] {
    return this.selectPricesStmt.all(productId);
  }

  getMinMaxPrice(productId: number): { lowest: number | null; highest: number | null } {
    const row = this.selectPriceRangeStmt.get(productId);
    return { lowest: row?.lowest ?? null, highest: row?.highest ?? null };
  }

  getPriceSummary(productId: number, limit = 500): PriceSummary {
    const safeLimit = Math.max(1, Math.min(5_000, Math.trunc(limit)));
    const currentPrice = this.selectLatestPriceStmt.get(productId)?.price ?? null;

    const previousPrice =
      currentPrice === null
        ? null
        : (this.selectPreviousDifferentPriceStmt.get({ productId, currentPrice })?.price ??
          null);

    // Fetch only the points needed by the chart, newest first, then reverse so
    // callers always receive an oldest-to-newest series. Keeping this query
    // bounded matters: the dashboard polls once per second.
    const history = this.selectRecentPricesStmt
      .all({ productId, limit: safeLimit })
      .reverse();

    const range = this.selectPriceRangeStmt.get(productId);
    return {
      history,
      currentPrice,
      previousPrice,
      lowestPrice: range?.lowest ?? null,
      highestPrice: range?.highest ?? null,
    };
  }

  getSetting(key: string): string | null {
    return this.selectSettingStmt.get(key)?.value ?? null;
  }

  getSettings(): Settings {
    const raw = this.getSetting('trackingIntervalSeconds');
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return {
      trackingIntervalSeconds: Number.isInteger(parsed)
        ? parsed
        : this.trackingIntervalSeconds,
    };
  }

  setSetting(key: string, value: string): void {
    this.upsertSettingStmt.run({ key, value });
  }

  setSettings(settings: Settings): void {
    const save = this.sqlite.transaction(() => {
      this.upsertSettingStmt.run({
        key: 'trackingIntervalSeconds',
        value: String(settings.trackingIntervalSeconds),
      });
    });
    save();
  }

  getAllSettings(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const row of this.selectSettingsStmt.all()) {
      result[row.key] = row.value;
    }
    return result;
  }

  close(): void {
    if (this.sqlite.open) this.sqlite.close();
  }

  private requireProduct(id: number): ProductRow {
    const product = this.getProduct(id);
    if (!product) throw new Error(`Product ${id} was not found after insert.`);
    return product;
  }
}

// Convenience alias for callers that use the shorter domain name.
export { AppDatabase as Database };
