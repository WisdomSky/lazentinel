import { DEFAULT_TRACKING_INTERVAL_SECONDS } from './config.js';
import type { PricePoint, ProductRow, Settings } from './db.js';
import { AppDatabase } from './db.js';
import {
  ConflictError,
  ScrapeError,
  isScrapeError,
  isUniqueConstraintError,
} from './errors.js';
import {
  canonicalizeLazadaProductUrl,
  normalizeLazadaUrl,
  type ScrapeResult,
  type ScraperLike,
} from './scraper.js';

export interface ProductDto {
  id: number;
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
  currentPrice: number | null;
  previousPrice: number | null;
  priceChange: number | null;
  dropPercent: number;
  lowestPrice: number | null;
  highestPrice: number | null;
  history: PricePoint[];
}

export type Product = ProductDto;

export type { PricePoint, Settings } from './db.js';

export interface AddProductResult {
  product: ProductDto;
  warning?: string;
}

export interface ServiceLogger {
  error(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

export interface ProductServiceOptions {
  logger?: ServiceLogger;
  /** Delay between products when scheduling a batch, to avoid a thundering herd. */
  staggerMs?: number;
  now?: () => Date;
}

export interface ProductServiceLike {
  listProducts(ownerId?: number): ProductDto[] | Promise<ProductDto[]>;
  addProduct(url: string, ownerId?: number): Promise<AddProductResult>;
  deleteProduct(id: number, ownerId?: number): boolean | Promise<boolean>;
  refreshProduct(
    id: number,
    ownerId?: number,
  ): Promise<AddProductResult | null>;
  getSettings(): Settings | Promise<Settings>;
}

export interface PriceSummary {
  history: PricePoint[];
  currentPrice: number | null;
  previousPrice: number | null;
  lowestPrice: number | null;
  highestPrice: number | null;
}

interface CheckOutcome {
  warning?: string;
  error?: Error;
}

export const PRICE_UNAVAILABLE_WARNING = "Price unavailable — we'll keep trying.";

function round2(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Builds the public DTO from a stored row and its price summary. */
export function toProductDto(row: ProductRow, summary: PriceSummary): ProductDto {
  const { currentPrice, previousPrice } = summary;
  const priceChange =
    currentPrice !== null && previousPrice !== null ? round2(currentPrice - previousPrice) : null;
  const dropPercent =
    currentPrice !== null && previousPrice !== null && previousPrice > 0
      ? round2(((previousPrice - currentPrice) / previousPrice) * 100)
      : 0;

  return {
    id: row.id,
    url: row.url,
    title: row.title,
    brand: row.brand,
    rating: row.rating,
    reviewCount: row.reviewCount,
    currency: row.currency,
    imageUrl: row.imageUrl,
    createdAt: row.createdAt,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    currentPrice,
    previousPrice,
    priceChange,
    dropPercent,
    lowestPrice: summary.lowestPrice,
    highestPrice: summary.highestPrice,
    history: summary.history,
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/**
 * Owns product lifecycle and background polling. No timers are created until
 * `start()` is invoked.
 */
export class ProductService implements ProductServiceLike {
  private readonly db: AppDatabase;
  private readonly scraper: ScraperLike;
  private readonly logger: ServiceLogger;
  private readonly staggerMs: number;
  private readonly now: () => Date;

  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<number, Promise<CheckOutcome>>();
  private running = false;

  constructor(db: AppDatabase, scraper: ScraperLike, options: ProductServiceOptions = {}) {
    this.db = db;
    this.scraper = scraper;
    this.logger = options.logger ?? {
      error: (...args: unknown[]) => console.error(...args),
      info: (...args: unknown[]) => console.info(...args),
    };
    this.staggerMs = Math.max(0, options.staggerMs ?? 750);
    this.now = options.now ?? (() => new Date());
  }

  listProducts(ownerId = 0): ProductDto[] {
    return this.db
      .listProducts(ownerId)
      .map((row) => this.buildProduct(row))
      .sort((left, right) => right.dropPercent - left.dropPercent || left.id - right.id);
  }

  async addProduct(inputUrl: string, ownerId = 0): Promise<AddProductResult> {
    const normalized = normalizeLazadaUrl(inputUrl);
    this.assertNotTracked(normalized.url, ownerId);

    let result: ScrapeResult;
    try {
      result = await this.scraper.scrape(normalized.url);
    } catch (error) {
      if (isScrapeError(error)) throw error;
      this.logger.error(`[tracker] Failed to scrape ${normalized.url}:`, error);
      throw new ScrapeError('NETWORK', 'Could not fetch that Lazada page. Please try again.', {
        cause: error,
      });
    }

    const resolvedUrl = canonicalizeLazadaProductUrl(result.product.url) ?? normalized.url;
    this.assertNotTracked(resolvedUrl, ownerId);

    const checkedAt = this.now().toISOString();
    const price =
      result.product.price !== null &&
      Number.isFinite(result.product.price) &&
      result.product.price > 0
        ? result.product.price
        : null;
    const warning = result.warning ?? (price === null ? PRICE_UNAVAILABLE_WARNING : undefined);

    let row: ProductRow;
    try {
      row = this.db.createProduct(
        {
          url: resolvedUrl,
          title: result.product.title,
          brand: result.product.brand,
          rating: result.product.rating,
          reviewCount: result.product.reviewCount,
          currency: result.product.currency,
          imageUrl: result.product.imageUrl,
          createdAt: checkedAt,
        },
        price,
        ownerId,
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictError('This product is already being tracked.');
      }
      throw error;
    }

    // Record the check itself (metadata + lastCheckedAt) without adding a second
    // price point. The initial price was inserted in the same transaction above.
    this.db.recordCheck(row.id, {
      checkedAt,
      price: null,
      metadata: {
        title: result.product.title,
        brand: result.product.brand,
        rating: result.product.rating,
        reviewCount: result.product.reviewCount,
        imageUrl: result.product.imageUrl,
      },
      error: price === null ? (warning ?? PRICE_UNAVAILABLE_WARNING) : null,
    });
    row = this.db.getProduct(row.id) ?? row;

    if (this.running) {
      this.scheduleProduct(row.id, this.intervalMs());
    }

    const product = this.buildProduct(this.db.getProduct(row.id) ?? row);
    return warning ? { product, warning } : { product };
  }

  deleteProduct(id: number, ownerId = 0): boolean {
    const deleted = this.db.deleteProductForOwner(id, ownerId);
    if (deleted) this.clearTimer(id);
    return deleted;
  }

  async refreshProduct(id: number, ownerId = 0): Promise<AddProductResult | null> {
    const row = this.db.getProduct(id);
    if (!row || row.userId !== ownerId) return null;

    const outcome = await this.checkProduct(row, true);
    const updated = this.db.getProduct(id);
    if (!updated) return null;

    const product = this.buildProduct(updated);
    return outcome.warning ? { product, warning: outcome.warning } : { product };
  }

  getSettings(): Settings {
    return this.db.getSettings();
  }

  /** Starts background tracking. Calling this more than once is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.rescheduleAll();
  }

  /** Stops all timers. In-flight fetches are allowed to finish but cannot reschedule. */
  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private assertNotTracked(url: string, ownerId: number): void {
    if (this.db.getProductByUrl(url, ownerId)) {
      throw new ConflictError('This product is already being tracked.');
    }
  }

  private intervalMs(): number {
    const { trackingIntervalSeconds } = this.db.getSettings();
    const seconds =
      trackingIntervalSeconds > 0
        ? trackingIntervalSeconds
        : DEFAULT_TRACKING_INTERVAL_SECONDS;
    return seconds * 1000;
  }

  private rescheduleAll(): void {
    const ids = this.db.getProductIds();
    const interval = this.intervalMs();
    ids.forEach((id, index) => {
      this.scheduleProduct(id, interval + index * this.staggerMs);
    });
  }

  private scheduleProduct(id: number, delayMs: number): void {
    this.clearTimer(id);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.runScheduledCheck(id);
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private clearTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private async runScheduledCheck(id: number): Promise<void> {
    if (!this.running) return;

    const row = this.db.getProduct(id);
    if (!row) {
      this.clearTimer(id);
      return;
    }

    try {
      await this.checkProduct(row, false);
    } catch (error) {
      this.logger.error(`[tracker] Unexpected check failure for product ${id}:`, error);
    }

    if (this.running && this.db.getProduct(id)) {
      this.scheduleProduct(id, this.intervalMs());
    }
  }

  private async checkProduct(row: ProductRow, throwOnError: boolean): Promise<CheckOutcome> {
    let promise = this.inFlight.get(row.id);
    if (!promise) {
      promise = this.fetchAndPersist(row).finally(() => {
        this.inFlight.delete(row.id);
      });
      this.inFlight.set(row.id, promise);
    }

    const outcome = await promise;
    if (throwOnError && outcome.error) throw outcome.error;
    return outcome;
  }

  private async fetchAndPersist(row: ProductRow): Promise<CheckOutcome> {
    try {
      const result = await this.scraper.scrape(row.url);
      // The product may have been deleted while the fetch was in flight.
      if (!this.db.getProduct(row.id)) {
        return { warning: result.warning };
      }

      const price =
        result.product.price !== null &&
        Number.isFinite(result.product.price) &&
        result.product.price > 0
          ? result.product.price
          : null;
      const warning =
        result.warning ?? (price === null ? PRICE_UNAVAILABLE_WARNING : undefined);
      this.db.recordCheck(row.id, {
        checkedAt: this.now().toISOString(),
        price,
        metadata: {
          title: result.product.title,
          brand: result.product.brand,
          rating: result.product.rating,
          reviewCount: result.product.reviewCount,
          imageUrl: result.product.imageUrl,
        },
        error: price === null ? (warning ?? PRICE_UNAVAILABLE_WARNING) : null,
      });

      return warning ? { warning } : {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[tracker] Price check failed for product ${row.id}:`, error);
      try {
        if (this.db.getProduct(row.id)) {
          this.db.recordCheck(row.id, {
            checkedAt: this.now().toISOString(),
            price: null,
            error: truncate(message || 'Unknown scrape error', 500),
          });
        }
      } catch (recordError) {
        this.logger.error(`[tracker] Could not record failure for product ${row.id}:`, recordError);
      }
      return { error: error instanceof Error ? error : new Error(message) };
    }
  }

  private buildProduct(row: ProductRow): ProductDto {
    return toProductDto(row, this.db.getPriceSummary(row.id, 500));
  }
}

export { ProductService as default };
