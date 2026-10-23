import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright-core';
import { TwoCaptchaBrowser, TwoCaptchaError } from '../twocaptcha.js';
import type { RenderRequest } from '../browser-renderer.js';
import type { ProxyEndpoint, ProxyProvider } from '../proxy/proxy_resolver.js';
import { silentLogger } from './helpers/fakes.js';

const REQUEST: RenderRequest = {
  url: 'https://www.lazada.com.ph/products/acme-earbuds-i123.html',
  locale: 'en-PH',
  timezoneId: 'Asia/Manila',
};

const PROXY: ProxyEndpoint = {
  host: '10.0.0.1',
  port: 5598,
  username: 'proxy-user',
  password: 'proxy-pass',
  protocol: 'http',
};

function makeProvider(): ProxyProvider {
  return {
    size: 19,
    nextProxy: vi.fn(async () => PROXY),
    reportFailure: () => undefined,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function failingConnect(): (uri: string) => Promise<Browser> {
  return vi.fn(async (_uri: string): Promise<Browser> => {
    throw new Error('offline');
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TwoCaptchaBrowser', () => {
  it('is disabled without an API key', async () => {
    vi.stubEnv('TWOCAPTCHA_API_KEY', '');
    const fetchImpl = vi.fn<typeof fetch>();
    const scraper = new TwoCaptchaBrowser({
      apiKey: '',
      fetchImpl,
      proxyProvider: makeProvider(),
      logger: silentLogger,
    });

    expect(scraper.configured).toBe(false);
    await expect(scraper.render(REQUEST)).rejects.toBeInstanceOf(TwoCaptchaError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a proxy provider', async () => {
    const scraper = new TwoCaptchaBrowser({
      apiKey: 'test-key',
      fetchImpl: vi.fn<typeof fetch>(),
      logger: silentLogger,
    });

    await expect(scraper.render(REQUEST)).rejects.toThrow(/proxy provider/);
  });

  it('gets a browser connection and surfaces CDP connection failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/browser/accounts') && method === 'GET') {
        return jsonResponse({ status: 'OK', data: { 0: { id: 42 } } });
      }
      if (url.includes('/browser/connection')) {
        return jsonResponse({ status: 'OK', connectionUri: 'ws://fake-browser' });
      }
      return jsonResponse({ status: 'error' }, 500);
    });
    const connectBrowser = failingConnect();
    const provider = makeProvider();
    const scraper = new TwoCaptchaBrowser({
      apiKey: 'test-key',
      fetchImpl,
      proxyProvider: provider,
      connectBrowser,
      logger: silentLogger,
    });

    await expect(scraper.render(REQUEST)).rejects.toThrow(/Could not connect/);

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/browser/accounts'),
      expect.anything(),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/browser/connection'),
      expect.anything(),
    );
    expect(connectBrowser).toHaveBeenCalledTimes(3);
    expect(provider.nextProxy).toHaveBeenCalledTimes(3);

    const connectionCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).includes('/browser/connection'),
    );
    expect(connectionCall).toBeDefined();
    const connectionBody = JSON.parse(String(connectionCall?.[1]?.body));
    expect(connectionBody).toMatchObject({
      key: 'test-key',
      accountId: 42,
      customProxy: {
        type: 'http',
        host: PROXY.host,
        port: PROXY.port,
        login: PROXY.username,
        password: PROXY.password,
      },
    });
  });

  it('creates a browser account when the key has none', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/browser/accounts') && method === 'GET') {
        return jsonResponse({ status: 'OK', data: {} });
      }
      if (url.includes('/browser/accounts') && method === 'POST') {
        return jsonResponse({ status: 'OK', account: { id: 7 } });
      }
      if (url.includes('/browser/connection')) {
        return jsonResponse({ status: 'OK', connectionUri: 'ws://fake-browser' });
      }
      return jsonResponse({ status: 'error' }, 500);
    });
    const scraper = new TwoCaptchaBrowser({
      apiKey: 'test-key',
      fetchImpl,
      proxyProvider: makeProvider(),
      connectBrowser: failingConnect(),
      logger: silentLogger,
    });

    await expect(scraper.render(REQUEST)).rejects.toThrow(/Could not connect/);

    const createCall = fetchImpl.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/browser/accounts') && init?.method === 'POST',
    );
    expect(createCall).toBeDefined();
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      key: 'test-key',
      name: 'Lazentinel',
      proxyMode: 'none',
    });
  });

  it('surfaces Browser API HTTP errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response('nope', { status: 500 }),
    );
    const connectBrowser = failingConnect();
    const scraper = new TwoCaptchaBrowser({
      apiKey: 'test-key',
      fetchImpl,
      proxyProvider: makeProvider(),
      connectBrowser,
      logger: silentLogger,
    });

    await expect(scraper.render(REQUEST)).rejects.toThrow(/HTTP 500/);
    expect(connectBrowser).not.toHaveBeenCalled();
  });
});
