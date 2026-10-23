import { existsSync } from 'node:fs';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright-core';
import { parsePrice } from './scraper.js';

type JsonObject = Record<string, unknown>;

const MTOP_DETAIL_PATH = /\/h5\/mtop\.global\.detail\.web\.getdetailinfo\/1\.0\//i;
const SYSTEM_CHROMIUM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
] as const;

export interface RenderRequest {
  url: string;
  locale: string;
  timezoneId: string;
}

export interface RenderedProduct {
  /** Final/canonical product URL reported by the rendered page or Mtop data. */
  url: string | null;
  title: string | null;
  brand: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** The displayed sale price, never the struck-through original/list price. */
  price: number | null;
  currency: string | null;
  imageUrl: string | null;
  sku: string | null;
}

export interface ProductRenderer {
  render(request: RenderRequest): Promise<RenderedProduct>;
  close(): Promise<void>;
}

export interface RendererLogger {
  error(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

export interface LazadaBrowserRendererOptions {
  executablePath?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  logger?: RendererLogger;
}

export class BrowserRenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BrowserRenderError';
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asIdentifier(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  return asString(value);
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  return parsePrice(value);
}

function asRating(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= 5
      ? Math.round(value * 100) / 100
      : null;
  }
  if (typeof value !== 'string') return null;
  const parsed = parsePrice(value);
  if (parsed === null || parsed > 5) return null;
  return Math.round(parsed * 100) / 100;
}

function asReviewCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([\d.,\s]+)\s*([km])?$/i);
  if (!match) return null;
  const suffix = (match[2] ?? '').toLowerCase();
  const raw = (match[1] ?? '').replace(/\s+/g, '');
  if (!raw) return null;

  let base: number;
  if (suffix) {
    const parts = raw.split(/[.,]/).filter(Boolean);
    // "1,2k" / "1.2k" use a decimal when there are at most two trailing digits;
    // otherwise separators are grouping characters.
    base =
      parts.length === 2 && (parts[1]?.length ?? 0) <= 2
        ? Number.parseFloat(`${parts[0]}.${parts[1]}`)
        : Number.parseFloat(raw.replace(/[.,]/g, ''));
  } else {
    // Review counts are integers; "1.234" and "1,234" both mean 1234.
    base = Number.parseFloat(raw.replace(/[.,]/g, ''));
  }

  if (!Number.isFinite(base) || base < 0) return null;
  return Math.round(base * (suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1));
}

function cleanBrand(value: string | null): string | null {
  if (!value) return null;
  return /^(no[\s-]?brand|unbranded|generic)$/i.test(value) ? null : value;
}

function normalizeImage(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === 'string') {
    let candidate = value.trim();
    if (!candidate) return null;
    if (candidate.startsWith('//')) candidate = `https:${candidate}`;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.toString();
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const image = normalizeImage(item, depth + 1);
      if (image) return image;
    }
    return null;
  }
  const object = asObject(value);
  if (!object) return null;
  for (const key of ['image', 'url', 'src', 'poster', 'contentUrl', 'images']) {
    const image = normalizeImage(object[key], depth + 1);
    if (image) return image;
  }
  return null;
}

/**
 * Extracts the current *displayed* price and review summary from the JSON
 * returned by Lazada's PDP Mtop endpoint. The endpoint represents prices as:
 *   { salePrice: { value: 3000 }, originalPrice: { value: 13990 } }
 * The HTML tracking payload's `pdt_price` is the original price for discounted
 * items, so it must never be used when this richer payload is available.
 */
export function extractMtopProductData(moduleValue: unknown): RenderedProduct | null {
  const module = asObject(moduleValue);
  if (!module) return null;

  const tracking = asObject(module.tracking);
  const product = asObject(module.product);
  const productBrand = asObject(product?.brand);
  const primaryKey = asObject(module.primaryKey);
  const skuInfos = asObject(module.skuInfos);

  const title = asString(tracking?.pdt_name) ?? asString(product?.title);
  const brand = cleanBrand(
    asString(productBrand?.name) ?? asString(tracking?.brand_name),
  );
  const productUrl = asString(product?.link);
  const trackingCore = asObject(tracking?.core);
  const globalConfig = asObject(module.globalConfig);
  const currency =
    asString(trackingCore?.currencyCode) ?? asString(globalConfig?.currency);

  const preferredSkuId =
    asIdentifier(primaryKey?.defaultSkuId) ?? asIdentifier(primaryKey?.skuId);
  const firstSkuEntry = skuInfos
    ? Object.entries(skuInfos).find(([, value]) => isObject(value))
    : undefined;
  const preferredSku = preferredSkuId && skuInfos ? asObject(skuInfos[preferredSkuId]) : null;
  const selectedSku = preferredSku ?? asObject(firstSkuEntry?.[1]);
  const selectedSkuId = preferredSku
    ? preferredSkuId
    : firstSkuEntry
      ? firstSkuEntry[0]
      : preferredSkuId;

  const priceObject = asObject(selectedSku?.price);
  const salePriceObject = asObject(priceObject?.salePrice);
  const price =
    asPositiveNumber(salePriceObject?.value) ??
    asPositiveNumber(salePriceObject?.text) ??
    asPositiveNumber(priceObject?.value) ??
    asPositiveNumber(priceObject?.text) ??
    asPositiveNumber(selectedSku?.price);

  const review = asObject(module.review);
  const rating = asRating(
    review?.averageRating ?? review?.ratingScore ?? review?.rating,
  );
  const reviewCount = asReviewCount(
    review?.reviews ??
      review?.contentedNum ??
      review?.reviewCount ??
      review?.ratingCount ??
      review?.total,
  );

  const imageUrl =
    normalizeImage(selectedSku?.image) ??
    normalizeImage(product?.image) ??
    normalizeImage(module.skuGalleries) ??
    normalizeImage(product?.images);

  if (!title && !productUrl && price === null && rating === null && reviewCount === null) {
    return null;
  }

  return {
    url: productUrl,
    title,
    brand,
    rating,
    reviewCount,
    price,
    currency,
    imageUrl,
    sku: selectedSkuId ?? null,
  };
}

export class LazadaBrowserRenderer implements ProductRenderer {
  private readonly executablePath: string | null;
  private readonly timeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly logger: RendererLogger;

  private browser: Browser | null = null;
  private browserVersion: string | null = null;
  private launchPromise: Promise<Browser> | null = null;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: LazadaBrowserRendererOptions = {}) {
    this.executablePath =
      options.executablePath?.trim() ||
      process.env.CHROMIUM_EXECUTABLE?.trim() ||
      null;
    this.timeoutMs = Math.max(5_000, options.timeoutMs ?? 22_000);
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 2));
    this.logger = options.logger ?? {
      error: (...args: unknown[]) => console.error(...args),
      info: (...args: unknown[]) => console.info(...args),
    };
  }

  async render(request: RenderRequest): Promise<RenderedProduct> {
    await this.acquireSlot();
    try {
      const browser = await this.ensureBrowser();
      const version = this.browserVersion ?? (await browser.version());
      const context = await browser.newContext({
        userAgent: this.userAgent(version),
        locale: request.locale,
        timezoneId: request.timezoneId,
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 1,
      });

      try {
        // Do not block images/fonts/media here. Lazada's price renderer is
        // sensitive to incomplete page loads and can withhold its Mtop detail
        // response when those requests are aborted.
        return await this.renderPage(context, request);
      } catch (error) {
        this.logger.error('[renderer] Live Lazada price render failed:', error);
        throw error;
      } finally {
        await context.close().catch((error: unknown) => {
          this.logger.error('[renderer] Could not close browser context:', error);
        });
      }
    } finally {
      this.releaseSlot();
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.browserVersion = null;
    if (!browser) return;
    try {
      await browser.close();
    } catch (error) {
      this.logger.error('[renderer] Could not close Chromium cleanly:', error);
    }
  }

  private async renderPage(
    context: BrowserContext,
    request: RenderRequest,
  ): Promise<RenderedProduct> {
    const page = await context.newPage();
    try {
      const dataPromise = this.waitForMtopData(page);
      void page
        .goto(request.url, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(this.timeoutMs, 20_000),
        })
        .then(() => this.tryDismissAgeGate(page))
        .catch(() => {
          // The data promise owns the timeout/error reported to callers.
        });

      const data = await dataPromise;
      const finalUrl = page.url();
      if (!data.url && /^https?:/i.test(finalUrl)) {
        data.url = finalUrl;
      }
      return data;
    } finally {
      await page.close().catch(() => {
        // The context is closed by the caller.
      });
    }
  }

  private waitForMtopData(page: Page): Promise<RenderedProduct> {
    return new Promise<RenderedProduct>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        page.off('response', onResponse);
        reject(
          new BrowserRenderError(
            "Lazada's live price data did not load in time.",
          ),
        );
      }, this.timeoutMs);

      const finish = (value: RenderedProduct) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        page.off('response', onResponse);
        resolve(value);
      };

      const onResponse = (response: import('playwright-core').Response) => {
        if (settled) return;
        const url = response.url();
        if (!MTOP_DETAIL_PATH.test(url) || url.includes('_____tmd_____')) return;

        void response
          .json()
          .then((payload: unknown) => {
            const data = asObject(asObject(payload)?.data);
            const rawModule = data?.module;
            if (typeof rawModule !== 'string' && !isObject(rawModule)) return;

            const module =
              typeof rawModule === 'string' ? JSON.parse(rawModule) : rawModule;
            const parsed = extractMtopProductData(module);
            if (parsed) finish(parsed);
          })
          .catch(() => {
            // Ignore token/challenge responses; the page retries them itself.
          });
      };

      page.on('response', onResponse);
    });
  }

  private async tryDismissAgeGate(page: Page): Promise<void> {
    const patterns = [/over 18/i, /i am (over )?18/i, /^yes,? enter$/i, /enter site/i];
    for (const pattern of patterns) {
      const locator = page.getByRole('button', { name: pattern }).first();
      const visible = await locator
        .isVisible({ timeout: 200 })
        .catch(() => false);
      if (!visible) continue;
      await locator.click({ timeout: 1_000 }).catch(() => undefined);
      return;
    }
  }

  private userAgent(version: string): string {
    const major = version.split('.')[0] || '141';
    const platform =
      process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : process.platform === 'win32'
          ? 'Windows NT 10.0; Win64; x64'
          : 'X11; Linux x86_64';
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launchPromise) return this.launchPromise;

    const launch = this.launchBrowser()
      .then((browser) => {
        this.browser = browser;
        this.browserVersion = browser.version();
        browser.on('disconnected', () => {
          if (this.browser === browser) {
            this.browser = null;
            this.browserVersion = null;
          }
        });
        this.logger.info?.(
          `[renderer] Chromium ${this.browserVersion} started for live Lazada prices.`,
        );
        return browser;
      })
      .catch((error: unknown) => {
        throw new BrowserRenderError(
          'The headless browser could not be started. Run "npm run setup:browser" or set CHROMIUM_EXECUTABLE.',
          { cause: error },
        );
      })
      .finally(() => {
        this.launchPromise = null;
      });

    this.launchPromise = launch;
    return launch;
  }

  private async launchBrowser(): Promise<Browser> {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--hide-scrollbars',
    ];
    const launchOptions = { headless: true, args } as const;

    if (this.executablePath) {
      return chromium.launch({
        ...launchOptions,
        executablePath: this.executablePath,
      });
    }

    let firstError: unknown;
    try {
      return await chromium.launch(launchOptions);
    } catch (error) {
      firstError = error;
    }

    // Fall back to a system Chrome/Chromium installation when the Playwright
    // browser cache has not been provisioned (common in local development).
    for (const executablePath of SYSTEM_CHROMIUM_PATHS) {
      if (!existsSync(executablePath)) continue;
      try {
        return await chromium.launch({ ...launchOptions, executablePath });
      } catch {
        // Try the next candidate.
      }
    }

    throw firstError instanceof Error
      ? firstError
      : new Error('No Chromium executable found.');
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}
