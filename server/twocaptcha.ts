import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import type {
  RenderFallback,
  RenderRequest,
  RenderedProduct,
  RendererLogger,
} from './browser-renderer.js';
import { extractMtopProductData } from './browser-renderer.js';
import type { ProxyEndpoint, ProxyProvider } from './proxy/proxy_resolver.js';

/**
 * Last-resort page source for Lazada after CloakBrowser has tried every
 * configured proxy host for the URL. It uses the 2Captcha Browser API: a cloud
 * browser is connected over CDP through one of the rotating proxies, the
 * marketplace homepage is opened first to establish the Mtop token cookies,
 * and then the product page's Mtop response is read directly.
 *
 * The Scraper API is intentionally not used: it only returns the serialized
 * DOM, while Lazada's displayed sale price lives in the Mtop XHR. The Browser
 * API lets us observe that response.
 */

const BROWSER_API_BASE = 'https://api.2captcha.com';
const MTOP_DETAIL_PATH = /\/h5\/mtop\.global\.detail\.web\.getdetailinfo\/1\.0\//i;
const BOT_CHALLENGE_URL = /_____tmd_____|\/punish(?:\?|$)|\bx5secdata=/i;
const DEFAULT_TIMEOUT_MS = 120_000;
const BROWSER_PAGE_TIMEOUT_MS = 30_000;
const BROWSER_MTOP_TIMEOUT_MS = 45_000;
const BROWSER_HOME_SETTLE_MS = 5_000;
const BROWSER_PROXY_ATTEMPTS = 3;

export class TwoCaptchaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TwoCaptchaError';
  }
}

export interface TwoCaptchaOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: RendererLogger;
  /** Supplies the rotating proxy used to connect the cloud browser. */
  proxyProvider?: ProxyProvider | null;
  /** Test seam for the CDP connection. Defaults to Playwright. */
  connectBrowser?: (connectionUri: string) => Promise<Browser>;
}

interface BrowserApiAccountResponse {
  data?: unknown;
  account?: unknown;
}

export class TwoCaptchaBrowser implements RenderFallback {
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly logger: RendererLogger;
  private readonly proxyProvider: ProxyProvider | null;
  private readonly connectBrowser: (connectionUri: string) => Promise<Browser>;

  private accountId: number | null = null;
  private browserQueue: Promise<unknown> = Promise.resolve();

  constructor(options: TwoCaptchaOptions = {}) {
    this.apiKey =
      options.apiKey?.trim() || process.env.TWOCAPTCHA_API_KEY?.trim() || '';
    this.configured = this.apiKey.length > 0;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = Math.max(10_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.logger = options.logger ?? {
      error: (...args: unknown[]) => console.error(...args),
      info: (...args: unknown[]) => console.info(...args),
    };
    this.proxyProvider = options.proxyProvider ?? null;
    this.connectBrowser =
      options.connectBrowser ??
      ((connectionUri) => chromium.connectOverCDP(connectionUri));
  }

  async render(request: RenderRequest): Promise<RenderedProduct> {
    if (!this.configured) {
      throw new TwoCaptchaError(
        'TWOCAPTCHA_API_KEY is not set; the Browser API fallback is disabled.',
      );
    }

    const provider = this.proxyProvider;
    if (!provider) {
      throw new TwoCaptchaError(
        'No proxy provider is configured for the 2Captcha Browser API.',
      );
    }

    // The Browser API profile supports one CDP connection at a time.
    return this.runBrowserExclusive(async () => {
      let lastError: unknown;

      for (let attempt = 0; attempt < BROWSER_PROXY_ATTEMPTS; attempt += 1) {
        let proxy: ProxyEndpoint;
        try {
          proxy = await provider.nextProxy();
        } catch (error) {
          lastError = error;
          break;
        }

        try {
          return await this.runBrowserSession(request, proxy);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError instanceof TwoCaptchaError
        ? lastError
        : new TwoCaptchaError(
            '2Captcha Browser API could not load the product page.',
            { cause: lastError },
          );
    });
  }

  private runBrowserExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.browserQueue.then(task, task);
    this.browserQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runBrowserSession(
    request: RenderRequest,
    proxy: ProxyEndpoint,
  ): Promise<RenderedProduct> {
    const accountId = await this.getAccountId();
    const connectionUri = await this.createBrowserConnection(accountId, proxy);

    let browser: Browser | null = null;
    try {
      try {
        browser = await this.connectBrowser(connectionUri);
      } catch {
        // Never include the CDP URL in the error: it carries the session
        // credentials.
        throw new TwoCaptchaError(
          'Could not connect to the 2Captcha Browser API.',
        );
      }

      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      try {
        page.setDefaultTimeout(BROWSER_PAGE_TIMEOUT_MS);

        // The profile is reused across fallback attempts. A challenge cookie
        // from one proxy must not poison the next proxy's session.
        await context.clearCookies().catch(() => undefined);

        try {
          await page.goto(marketplaceHomeUrl(request.url), {
            waitUntil: 'domcontentloaded',
            timeout: BROWSER_PAGE_TIMEOUT_MS,
          });
        } catch (error) {
          throw new TwoCaptchaError(
            '2Captcha Browser API could not load the Lazada homepage.',
            { cause: error },
          );
        }
        // Let the homepage establish the Mtop token cookies before opening the
        // product. Without this, Lazada's first detail request can be rejected.
        await page.waitForTimeout(BROWSER_HOME_SETTLE_MS);
        if (BOT_CHALLENGE_URL.test(page.url())) {
          throw new TwoCaptchaError(
            '2Captcha Browser API hit a Lazada challenge on the homepage.',
          );
        }

        const navigation = page.goto(request.url, {
          waitUntil: 'domcontentloaded',
          timeout: BROWSER_PAGE_TIMEOUT_MS,
        });
        const product = await this.waitForBrowserMtop(page, navigation);
        if (product.price === null) {
          throw new TwoCaptchaError(
            '2Captcha Browser API loaded the product but found no displayed price.',
          );
        }
        return product;
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  private async getAccountId(): Promise<number> {
    if (this.accountId !== null) return this.accountId;

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${BROWSER_API_BASE}/browser/accounts?key=${encodeURIComponent(this.apiKey)}`,
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch {
      throw new TwoCaptchaError('Could not reach the 2Captcha Browser API.');
    }

    if (!response.ok) {
      throw new TwoCaptchaError(
        `2Captcha Browser API returned HTTP ${response.status}.`,
      );
    }

    let payload: BrowserApiAccountResponse;
    try {
      payload = (await response.json()) as BrowserApiAccountResponse;
    } catch {
      throw new TwoCaptchaError('2Captcha Browser API returned invalid JSON.');
    }

    if (isRecord(payload.data)) {
      for (const account of Object.values(payload.data)) {
        if (isRecord(account) && typeof account.id === 'number') {
          this.accountId = account.id;
          return account.id;
        }
      }
    }

    let createResponse: Response;
    try {
      createResponse = await this.fetchImpl(`${BROWSER_API_BASE}/browser/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: this.apiKey,
          name: 'Lazentinel',
          proxyMode: 'none',
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new TwoCaptchaError(
        'Could not create a 2Captcha Browser API account.',
      );
    }

    if (!createResponse.ok) {
      throw new TwoCaptchaError(
        `2Captcha Browser API returned HTTP ${createResponse.status}.`,
      );
    }

    let createPayload: BrowserApiAccountResponse;
    try {
      createPayload = (await createResponse.json()) as BrowserApiAccountResponse;
    } catch {
      throw new TwoCaptchaError('2Captcha Browser API returned invalid JSON.');
    }

    if (isRecord(createPayload.account) && typeof createPayload.account.id === 'number') {
      this.accountId = createPayload.account.id;
      return createPayload.account.id;
    }

    throw new TwoCaptchaError(
      '2Captcha Browser API did not return a browser account.',
    );
  }

  private async createBrowserConnection(
    accountId: number,
    proxy: ProxyEndpoint,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${BROWSER_API_BASE}/browser/connection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: this.apiKey,
          accountId,
          customProxy: {
            type: proxy.protocol,
            host: proxy.host,
            port: proxy.port,
            login: proxy.username,
            password: proxy.password,
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new TwoCaptchaError('Could not reach the 2Captcha Browser API.');
    }

    if (!response.ok) {
      throw new TwoCaptchaError(
        `2Captcha Browser API returned HTTP ${response.status}.`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TwoCaptchaError('2Captcha Browser API returned invalid JSON.');
    }

    if (
      !isRecord(payload) ||
      typeof payload.connectionUri !== 'string' ||
      payload.connectionUri.length === 0
    ) {
      throw new TwoCaptchaError(
        '2Captcha Browser API did not return a connection URI.',
      );
    }

    return payload.connectionUri;
  }

  private waitForBrowserMtop(
    page: Page,
    navigation: Promise<unknown>,
  ): Promise<RenderedProduct> {
    return new Promise<RenderedProduct>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        page.off('response', onResponse);
        page.off('framenavigated', onFrame);
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
          ? new TwoCaptchaError(
              '2Captcha Browser API hit a Lazada challenge page.',
            )
          : null;

      timer = setTimeout(() => {
        fail(
          challengeError() ??
            new TwoCaptchaError(
              "Lazada's Mtop price data did not load through the 2Captcha Browser API.",
            ),
        );
      }, BROWSER_MTOP_TIMEOUT_MS);

      const onFrame = (frame: import('playwright-core').Frame) => {
        if (frame !== page.mainFrame()) return;
        const error = challengeError();
        if (error) fail(error);
      };

      const onResponse = (response: import('playwright-core').Response) => {
        if (settled) return;
        const url = response.url();
        if (!MTOP_DETAIL_PATH.test(url) || url.includes('_____tmd_____')) return;

        void response
          .json()
          .then((payload: unknown) => {
            const data = isRecord(payload) ? payload.data : null;
            const rawModule = isRecord(data) ? data.module : null;
            if (typeof rawModule !== 'string' && !isRecord(rawModule)) return;

            const module =
              typeof rawModule === 'string' ? JSON.parse(rawModule) : rawModule;
            const parsed = extractMtopProductData(module);
            if (parsed) succeed(parsed);
          })
          .catch(() => {
            // Ignore token/challenge responses; the page may retry them.
          });
      };

      page.on('response', onResponse);
      page.on('framenavigated', onFrame);
      void navigation.catch((error: unknown) => {
        fail(
          new TwoCaptchaError(
            '2Captcha Browser API could not load the product page.',
            { cause: error },
          ),
        );
      });

      const challenge = challengeError();
      if (challenge) fail(challenge);
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function marketplaceHomeUrl(productUrl: string): string {
  const url = new URL(productUrl);
  const host = url.hostname.startsWith('s.')
    ? `www.${url.hostname.slice(2)}`
    : url.hostname;
  return `${url.protocol}//${host}/`;
}
