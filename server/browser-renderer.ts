import { launch } from 'cloakbrowser';
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from 'playwright-core';
import type { ProxyEndpoint, ProxyProvider } from './proxy/proxy_resolver.js';
import {
  BotChallengeError,
  BrowserRenderError,
  RenderBlockedError,
} from './renderer-errors.js';
import { parsePrice } from './scraper.js';

export {
  BrowserRenderError,
  RenderBlockedError,
  isRenderBlockedError,
} from './renderer-errors.js';

type JsonObject = Record<string, unknown>;

const MTOP_DETAIL_PATH = /\/h5\/mtop\.global\.detail\.web\.getdetailinfo\/1\.0\//i;
const BOT_CHALLENGE_URL = /_____tmd_____|\/punish(?:\?|$)|\bx5secdata=/i;
const PROXY_FAILURE_PATTERN =
  /net::ERR_(?:PROXY|TUNNEL|CONNECTION|NAME|TIMED_OUT|SOCKS|ADDRESS_UNREACHABLE|NETWORK_CHANGED|INTERNET_DISCONNECTED)|\bECONN(?:REFUSED|RESET|ABORTED)\b/i;
const NETWORK_TIMEOUT_PATTERN = /Timeout \d+ms exceeded/i;
const BLOCKED_URL_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const PAGE_CLOSE_TIMEOUT_MS = 3_000;
const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;
const ATTEMPT_TIMEOUT_PADDING_MS = 10_000;

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
  /** True when all browser traffic goes through a proxy. */
  readonly usesProxy?: boolean;
}

/** A last-resort page source used after every proxy has failed. */
export interface RenderFallback {
  readonly configured: boolean;
  render(request: RenderRequest): Promise<RenderedProduct>;
}

export interface RendererLogger {
  error(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

export interface LazadaBrowserRendererOptions {
  /** Optional Chromium binary; skips CloakBrowser's managed download. */
  executablePath?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  logger?: RendererLogger;
  /** Rotating proxy pool. Omit to connect directly or use CLOAKBROWSER_PROXY. */
  proxyResolver?: ProxyProvider | null;
  /** Last-resort page source used only after the proxy pool is exhausted. */
  fallback?: RenderFallback | null;
}

function isProxyFailure(error: unknown): boolean {
  if (error instanceof BotChallengeError) return false;
  const message = error instanceof Error ? error.message : String(error);
  return PROXY_FAILURE_PATTERN.test(message) || NETWORK_TIMEOUT_PATTERN.test(message);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrowserRenderError(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
  private readonly timeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly logger: RendererLogger;
  private readonly proxyResolver: ProxyProvider | null;
  private readonly fallback: RenderFallback | null;
  private readonly blockedUrls = new Map<string, number>();

  private browser: Browser | null = null;
  private browserVersion: string | null = null;
  private launchPromise: Promise<Browser> | null = null;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: LazadaBrowserRendererOptions = {}) {
    const executablePath =
      options.executablePath?.trim() ||
      process.env.CLOAKBROWSER_BINARY_PATH?.trim() ||
      // Legacy name kept so existing deployments keep working.
      process.env.CHROMIUM_EXECUTABLE?.trim() ||
      null;
    this.timeoutMs = Math.max(5_000, options.timeoutMs ?? 22_000);
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 2));
    this.logger = options.logger ?? {
      error: (...args: unknown[]) => console.error(...args),
      info: (...args: unknown[]) => console.info(...args),
    };
    this.proxyResolver = options.proxyResolver ?? null;
    this.fallback = options.fallback ?? null;
    // CloakBrowser reads this before downloading its stealth binary, so an
    // explicit path skips the download instead of only overriding the launch.
    if (executablePath) {
      process.env.CLOAKBROWSER_BINARY_PATH = executablePath;
    }
  }

  get usesProxy(): boolean {
    return (
      (this.proxyResolver?.size ?? 0) > 0 ||
      Boolean(process.env.CLOAKBROWSER_PROXY?.trim())
    );
  }

  async render(request: RenderRequest): Promise<RenderedProduct> {
    const blockedUntil = this.blockedUrls.get(request.url);
    if (blockedUntil !== undefined) {
      if (blockedUntil > Date.now()) {
        throw new RenderBlockedError(
          `Lazada is still blocking this product. Pausing checks for 3 hours (until ${new Date(blockedUntil).toISOString()}).`,
          blockedUntil,
        );
      }
      this.blockedUrls.delete(request.url);
    }

    await this.acquireSlot();
    try {
      const proxyProvider = this.proxyResolver;
      if (!proxyProvider || proxyProvider.size === 0) {
        return await this.renderWithBrowser(request, null);
      }

      const attempted = new Set<string>();
      let lastError: unknown;
      let sweepComplete = true;

      for (;;) {
        let endpoint: ProxyEndpoint;
        try {
          endpoint = await proxyProvider.nextProxy(attempted, {
            includeUnavailable: true,
          });
        } catch (error) {
          lastError = error;
          break;
        }

        try {
          return await withTimeout(
            this.renderWithBrowser(request, endpoint),
            this.timeoutMs + ATTEMPT_TIMEOUT_PADDING_MS,
            `Timeout ${this.timeoutMs + ATTEMPT_TIMEOUT_PADDING_MS}ms exceeded while rendering the page.`,
          );
        } catch (error) {
          lastError = error;
          if (error instanceof BotChallengeError) {
            this.logger.info?.(
              `[renderer] Bot challenge via proxy ${endpoint.host}; trying another host.`,
            );
            continue;
          }
          if (isProxyFailure(error)) {
            this.logger.info?.(
              `[renderer] Proxy ${endpoint.host} failed; trying another host.`,
            );
            proxyProvider.reportFailure(endpoint);
            continue;
          }
          if (
            error instanceof BrowserRenderError &&
            /could not be started/i.test(error.message)
          ) {
            sweepComplete = false;
            this.logger.error(
              '[renderer] The stealth browser could not start; trying the 2Captcha Browser API.',
            );
            break;
          }
          // The full sweep is mandatory before 2Captcha. Keep going until every
          // configured host has been attempted for this URL.
          if (this.fallback?.configured) {
            this.logger.info?.(
              '[renderer] Browser render failed; trying the next proxy before the 2Captcha fallback.',
            );
            continue;
          }
          this.logger.error('[renderer] Live Lazada price render failed:', error);
          throw error;
        }
      }

      if (this.fallback?.configured) {
        this.logger.info?.(
          sweepComplete
            ? `[renderer] All ${attempted.size} configured proxy hosts were attempted for ${request.url}; trying the 2Captcha Browser API.`
            : `[renderer] The stealth browser could not start for ${request.url}; trying the 2Captcha Browser API.`,
        );
        try {
          const rendered = await this.fallback.render(request);
          this.logger.info?.(
            `[renderer] 2Captcha Browser API returned product data for ${request.url} (price: ${rendered.price ?? 'unavailable'}).`,
          );
          return rendered;
        } catch (error) {
          lastError = error;
          this.logger.error(
            '[renderer] 2Captcha Browser API fallback failed:',
            error,
          );
        }
      }

      const retryAt = Date.now() + BLOCKED_URL_COOLDOWN_MS;
      this.blockedUrls.set(request.url, retryAt);
      this.logger.error(
        this.fallback?.configured
          ? `[renderer] All proxies and the 2Captcha Browser API failed for ${request.url}; pausing this product for 3 hours.`
          : `[renderer] Every proxy failed for ${request.url}; pausing this product for 3 hours.`,
      );
      throw new RenderBlockedError(
        this.fallback?.configured
          ? 'Lazada blocked every proxy and the 2Captcha Browser API fallback failed. Pausing checks for this product for 3 hours.'
          : 'Lazada blocked every available proxy. Pausing checks for this product for 3 hours.',
        retryAt,
        { cause: lastError },
      );
    } finally {
      this.releaseSlot();
    }
  }

  private async renderWithBrowser(
    request: RenderRequest,
    proxy: ProxyEndpoint | null,
  ): Promise<RenderedProduct> {
    const browser = await this.ensureBrowser();
    const contextOptions: BrowserContextOptions = {
      locale: request.locale,
      timezoneId: request.timezoneId,
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    };
    if (proxy) {
      contextOptions.proxy = {
        server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
        username: proxy.username,
        password: proxy.password,
      };
    }

    const context = await browser.newContext(contextOptions);
    try {
      // Do not block images/fonts/media here. Lazada's price renderer is
      // sensitive to incomplete page loads and can withhold its Mtop detail
      // response when those requests are aborted.
      return await this.renderPage(context, request);
    } finally {
      await withTimeout(
        context.close(),
        CONTEXT_CLOSE_TIMEOUT_MS,
        `Timeout ${CONTEXT_CLOSE_TIMEOUT_MS}ms exceeded while closing the browser context.`,
      ).catch((error: unknown) => {
        this.logger.error('[renderer] Could not close browser context:', error);
      });
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.browserVersion = null;
    this.blockedUrls.clear();
    if (!browser) return;
    try {
      await withTimeout(
        browser.close(),
        10_000,
        'Timeout 10000ms exceeded while closing CloakBrowser.',
      );
    } catch (error) {
      this.logger.error('[renderer] Could not close CloakBrowser cleanly:', error);
    }
  }

  private async renderPage(
    context: BrowserContext,
    request: RenderRequest,
  ): Promise<RenderedProduct> {
    const page = await context.newPage();
    try {
      const navigation = page
        .goto(request.url, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(this.timeoutMs, 20_000),
        })
        .then(() => this.tryDismissAgeGate(page));

      const data = await this.waitForMtopData(page, navigation);
      const finalUrl = page.url();
      if (!data.url && /^https?:/i.test(finalUrl)) {
        data.url = finalUrl;
      }
      return data;
    } finally {
      await withTimeout(
        page.close().catch(() => undefined),
        PAGE_CLOSE_TIMEOUT_MS,
        `Timeout ${PAGE_CLOSE_TIMEOUT_MS}ms exceeded while closing the page.`,
      ).catch(() => {
        // A stuck proxy can leave page.close() hanging. The context close and
        // the per-attempt timeout still free the caller.
      });
    }
  }

  private waitForMtopData(
    page: Page,
    navigation: Promise<void>,
  ): Promise<RenderedProduct> {
    return new Promise<RenderedProduct>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        page.off('response', onResponse);
        page.off('framenavigated', onFrameNavigated);
      };

      const succeed = (value: RenderedProduct) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const challengeError = () =>
        BOT_CHALLENGE_URL.test(page.url())
          ? new BotChallengeError()
          : null;

      timer = setTimeout(() => {
        fail(
          challengeError() ??
            new BrowserRenderError(
              "Lazada's live price data did not load in time.",
            ),
        );
      }, this.timeoutMs);

      const onFrameNavigated = (frame: import('playwright-core').Frame) => {
        if (frame !== page.mainFrame()) return;
        const challenge = challengeError();
        if (challenge) fail(challenge);
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
            if (parsed) succeed(parsed);
          })
          .catch(() => {
            // Ignore token/challenge responses; the page retries them itself.
          });
      };

      page.on('response', onResponse);
      page.on('framenavigated', onFrameNavigated);
      void navigation.catch((error: unknown) => {
        fail(challengeError() ?? error);
      });

      // A fast redirect may have completed before the listener was attached.
      const challenge = challengeError();
      if (challenge) fail(challenge);
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
      await locator.click({ timeout: 5_000 }).catch(() => undefined);
      return;
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launchPromise) return this.launchPromise;

    const pending = this.launchBrowser()
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
          `[renderer] CloakBrowser (Chromium ${this.browserVersion}) started for live Lazada prices.`,
        );
        return browser;
      })
      .catch((error: unknown) => {
        throw new BrowserRenderError(
          'The stealth browser could not be started. Run "npm run setup:browser" or set CLOAKBROWSER_BINARY_PATH.',
          { cause: error },
        );
      })
      .finally(() => {
        this.launchPromise = null;
      });

    this.launchPromise = pending;
    return pending;
  }

  private async launchBrowser(): Promise<Browser> {
    // A rotating pool is applied per browser context. Only fall back to the
    // single static proxy when no resolver is supplying one.
    const hasResolver = (this.proxyResolver?.size ?? 0) > 0;
    const proxy = hasResolver
      ? undefined
      : process.env.CLOAKBROWSER_PROXY?.trim();
    return launch({
      headless: true,
      // Human-like pointer/keyboard behavior matters when Lazada shows an age
      // gate or a challenge. Fingerprint patches are compiled into the binary;
      // humanize only changes how Playwright interacts with the page.
      humanize: true,
      ...(proxy ? { proxy } : {}),
      args: ['--disable-dev-shm-usage'],
    });
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
