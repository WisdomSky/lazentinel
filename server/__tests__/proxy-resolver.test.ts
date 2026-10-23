import { describe, expect, it, vi } from 'vitest';
import {
  ProxyResolver,
  ProxyUnavailableError,
  type ProxyLocation,
  type ProxyResolverOptions,
} from '../proxy/proxy_resolver.js';

const LOCATIONS: ProxyLocation[] = [
  { ip: '10.0.0.1', port: 5598, country: 'AL' },
  { ip: '10.0.0.2', port: 5598, country: 'AU' },
  { ip: '10.0.0.3', port: 5598, country: 'CA' },
];
const PROVIDERS = ['https://auth-one.test', 'https://auth-two.test'];
const TOKEN = 'a'.repeat(64);

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function makeResolver(options: Partial<ProxyResolverOptions> = {}): ProxyResolver {
  return new ProxyResolver({
    locations: LOCATIONS,
    authProviders: PROVIDERS,
    fetchImpl: async () => textResponse(TOKEN),
    logger: { error: () => {}, info: () => {} },
    ...options,
  });
}

describe('ProxyResolver', () => {
  it('resolves a credential token from the auth provider', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => textResponse(TOKEN));
    const resolver = makeResolver({ fetchImpl });

    const proxy = await resolver.nextProxy();

    expect(proxy).toMatchObject({
      host: '10.0.0.1',
      port: 5598,
      protocol: 'http',
      username: TOKEN,
      password: TOKEN,
      country: 'AL',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(requestedUrl).toContain('action=proxyauth');
    expect(requestedUrl).toContain('ip=10.0.0.1');
  });

  it('rotates hosts and never returns the same host consecutively', async () => {
    const resolver = makeResolver();
    const hosts: string[] = [];

    for (let index = 0; index < 6; index += 1) {
      const proxy = await resolver.nextProxy();
      hosts.push(proxy.host);
    }

    expect(hosts).toEqual([
      '10.0.0.1',
      '10.0.0.2',
      '10.0.0.3',
      '10.0.0.1',
      '10.0.0.2',
      '10.0.0.3',
    ]);
    for (let index = 1; index < hosts.length; index += 1) {
      expect(hosts[index]).not.toBe(hosts[index - 1]);
    }
  });

  it('caches credentials per host', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => textResponse(TOKEN));
    const resolver = makeResolver({ fetchImpl, locations: LOCATIONS.slice(0, 2) });

    await resolver.nextProxy(); // 10.0.0.1
    await resolver.nextProxy(); // 10.0.0.2
    const third = await resolver.nextProxy(); // 10.0.0.1 again, cached

    expect(third.host).toBe('10.0.0.1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to the next auth provider when one fails', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('provider one is down'))
      .mockResolvedValueOnce(textResponse(TOKEN));
    const resolver = makeResolver({ fetchImpl });

    const proxy = await resolver.nextProxy();

    expect(proxy.host).toBe('10.0.0.1');
    expect(proxy.username).toBe(TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('tries another host when credentials cannot be resolved', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('provider one is down'))
      .mockRejectedValueOnce(new Error('provider two is down'))
      .mockResolvedValueOnce(textResponse(TOKEN));
    const resolver = makeResolver({ fetchImpl });

    const proxy = await resolver.nextProxy();

    expect(proxy.host).toBe('10.0.0.2');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not return the same host for concurrent calls', async () => {
    const resolver = makeResolver();

    const [first, second] = await Promise.all([
      resolver.nextProxy(),
      resolver.nextProxy(),
    ]);

    expect(first.host).not.toBe(second.host);
  });

  it('disables a host when its credentials are unchanged after a failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => textResponse(TOKEN));
    const resolver = makeResolver({ fetchImpl, locations: LOCATIONS.slice(0, 2) });

    const first = await resolver.nextProxy(); // 10.0.0.1
    resolver.reportFailure(first);

    const second = await resolver.nextProxy(); // 10.0.0.2
    expect(second.host).toBe('10.0.0.2');

    // Back to 10.0.0.1. The same token comes back, so the host is disabled and
    // the resolver falls through to 10.0.0.2.
    const third = await resolver.nextProxy();
    expect(third.host).toBe('10.0.0.2');

    await expect(resolver.nextProxy(new Set(['10.0.0.2']))).rejects.toBeInstanceOf(
      ProxyUnavailableError,
    );
  });

  it('uses new credentials when they change after a failure', async () => {
    const changedToken = 'b'.repeat(64);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(textResponse(TOKEN))
      .mockResolvedValueOnce(textResponse(TOKEN))
      .mockResolvedValueOnce(textResponse(changedToken));
    const resolver = makeResolver({ fetchImpl, locations: LOCATIONS.slice(0, 2) });

    const first = await resolver.nextProxy(); // 10.0.0.1 with TOKEN
    resolver.reportFailure(first);
    await resolver.nextProxy(); // 10.0.0.2 with TOKEN

    const retried = await resolver.nextProxy();
    expect(retried.host).toBe('10.0.0.1');
    expect(retried.username).toBe(changedToken);
  });

  it('skips a host whose auth provider is cooling down', async () => {
    let now = 1_000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(textResponse(TOKEN))
      .mockResolvedValueOnce(textResponse(TOKEN));
    const resolver = makeResolver({
      fetchImpl,
      locations: LOCATIONS.slice(0, 2),
      now: () => now,
      authFailureCooldownMs: 60_000,
    });

    expect((await resolver.nextProxy()).host).toBe('10.0.0.2');
    await expect(resolver.nextProxy()).rejects.toBeInstanceOf(ProxyUnavailableError);

    now += 60_001;
    const recovered = await resolver.nextProxy();
    expect(recovered.host).toBe('10.0.0.1');
  });

  it('rejects when only one host is configured and it was just used', async () => {
    const resolver = makeResolver({ locations: LOCATIONS.slice(0, 1) });

    await resolver.nextProxy();
    await expect(resolver.nextProxy()).rejects.toBeInstanceOf(ProxyUnavailableError);
  });

  it('rejects an unexpected auth response and tries the next provider', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(textResponse('<html>error</html>'))
      .mockResolvedValueOnce(textResponse(TOKEN));
    const resolver = makeResolver({ fetchImpl });

    const proxy = await resolver.nextProxy();

    expect(proxy.username).toBe(TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
