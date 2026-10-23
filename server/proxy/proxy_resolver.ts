import { readFileSync } from 'node:fs';

/**
 * Resolves rotating outbound proxies for Lazada requests.
 *
 * Proxy hosts and the auth services that issue their credentials live in the
 * two JSON files next to this module. Credentials are cached per host and only
 * re-requested after that host fails. A host whose credentials did not change
 * after a failure is treated as down and taken out of rotation for a while.
 */

export type ProxyProtocol = 'http' | 'socks5';

export interface ProxyLocation {
  country?: string;
  countryname?: string;
  ip: string;
  port: number;
  location?: string;
}

/** A fully resolved proxy, ready for Playwright's `proxy` context option. */
export interface ProxyEndpoint {
  host: string;
  port: number;
  username: string;
  password: string;
  protocol: ProxyProtocol;
  country?: string;
  label?: string;
}

export interface ProxyProvider {
  readonly size: number;
  nextProxy(
    exclude?: Set<string>,
    options?: { includeUnavailable?: boolean },
  ): Promise<ProxyEndpoint>;
  reportFailure(endpoint: ProxyEndpoint): void;
}

export interface ProxyLogger {
  error(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

export interface ProxyResolverOptions {
  locations?: readonly ProxyLocation[];
  authProviders?: readonly string[];
  fetchImpl?: typeof fetch;
  logger?: ProxyLogger;
  timeoutMs?: number;
  now?: () => number;
  protocol?: ProxyProtocol;
  /** How long a host with unchanged credentials stays out of rotation. */
  hostDisableMs?: number;
  /** How long a host stays out of rotation after credential resolution fails. */
  authFailureCooldownMs?: number;
}

interface Credentials {
  username: string;
  password: string;
}

interface HostState {
  location: ProxyLocation;
  credentials: Credentials | null;
  /** Credentials that were in use when this host last failed. */
  lastFailedCredentials: Credentials | null;
  pending: Promise<Credentials> | null;
  disabledUntil: number;
  authCooldownUntil: number;
}

export class ProxyUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProxyUnavailableError';
  }
}

/** Thrown when new credentials equal the ones that just failed. */
export class ProxyHostDisabledError extends Error {
  constructor(host: string) {
    super(`Proxy host ${host} returned unchanged credentials after a failure.`);
    this.name = 'ProxyHostDisabledError';
  }
}

export class ProxyAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProxyAuthError';
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_HOST_DISABLE_MS = 3 * 60 * 60 * 1000;
const DEFAULT_AUTH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

function readJson<T>(fileName: string): T {
  return JSON.parse(readFileSync(new URL(fileName, import.meta.url), 'utf8')) as T;
}

function isLocation(value: unknown): value is ProxyLocation {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ip === 'string' &&
    record.ip.trim().length > 0 &&
    Number.isInteger(record.port) &&
    (record.port as number) > 0 &&
    (record.port as number) <= 65_535
  );
}

function loadLocations(): ProxyLocation[] {
  const raw = readJson<unknown>('./proxy_locations.json');
  if (!Array.isArray(raw)) {
    throw new Error('proxy_locations.json must contain an array.');
  }
  return raw.filter(isLocation);
}

function normalizeProviders(raw: readonly string[]): string[] {
  const providers = new Set<string>();
  for (const candidate of raw) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      providers.add(url.toString());
    } catch {
      // Ignore malformed provider entries.
    }
  }
  return [...providers];
}

function loadProviders(): string[] {
  const raw = readJson<unknown>('./proxy_auth_providers.json');
  if (!Array.isArray(raw)) {
    throw new Error('proxy_auth_providers.json must contain an array.');
  }
  return normalizeProviders(raw.filter((value): value is string => typeof value === 'string'));
}

function isCredentialValue(value: string): boolean {
  return (
    value.length >= 8 &&
    value.length <= 512 &&
    !/\s/.test(value) &&
    !value.startsWith('<') &&
    !value.startsWith('{') &&
    !value.startsWith('[')
  );
}

function sameCredentials(left: Credentials, right: Credentials): boolean {
  return left.username === right.username && left.password === right.password;
}

function defaultProtocol(): ProxyProtocol {
  return process.env.PROXY_SCHEME?.trim().toLowerCase() === 'socks5' ? 'socks5' : 'http';
}

export class ProxyResolver implements ProxyProvider {
  private readonly states: HostState[];
  private readonly statesByHost: Map<string, HostState>;
  private readonly authProviders: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly logger: ProxyLogger;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly protocol: ProxyProtocol;
  private readonly hostDisableMs: number;
  private readonly authFailureCooldownMs: number;

  private cursor = 0;
  private lastHost: string | null = null;

  constructor(options: ProxyResolverOptions = {}) {
    const locations = options.locations ?? loadLocations();
    const providers = options.authProviders ?? loadProviders();

    const byHost = new Map<string, ProxyLocation>();
    for (const location of locations) {
      if (!isLocation(location)) continue;
      const host = location.ip.trim();
      byHost.set(host, { ...location, ip: host });
    }

    this.states = [...byHost.values()].map((location) => ({
      location,
      credentials: null,
      lastFailedCredentials: null,
      pending: null,
      disabledUntil: 0,
      authCooldownUntil: 0,
    }));
    this.statesByHost = new Map(this.states.map((state) => [state.location.ip, state]));
    this.authProviders = normalizeProviders(providers);

    if (this.states.length === 0) {
      throw new Error('No usable proxy locations are configured.');
    }
    if (this.authProviders.length === 0) {
      throw new Error('No usable proxy auth providers are configured.');
    }

    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger ?? {
      error: (...args: unknown[]) => console.error(...args),
      info: (...args: unknown[]) => console.info(...args),
    };
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.now = options.now ?? (() => Date.now());
    this.protocol = options.protocol ?? defaultProtocol();
    this.hostDisableMs = Math.max(0, options.hostDisableMs ?? DEFAULT_HOST_DISABLE_MS);
    this.authFailureCooldownMs = Math.max(
      0,
      options.authFailureCooldownMs ?? DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
    );
  }

  /** Number of configured proxy hosts. */
  get size(): number {
    return this.states.length;
  }

  /**
   * Returns the next proxy in round-robin order. Consecutive calls never return
   * the same host. `exclude` is the caller's attempted-host set: hosts in it
   * are skipped, and every host this call tries (including hosts whose
   * credentials fail) is added to it.
   *
   * `includeUnavailable` forces a full sweep: hosts in a credential cooldown or
   * disabled by an earlier failure are still returned. The browser renderer uses
   * this to guarantee that 2Captcha is only considered after every configured
   * proxy host has been attempted for the URL.
   *
   * Credential resolution can fail for an individual host; in that case the
   * next host is tried immediately.
   */
  async nextProxy(
    exclude: Set<string> = new Set(),
    options: { includeUnavailable?: boolean } = {},
  ): Promise<ProxyEndpoint> {
    const skipped = exclude;
    const includeUnavailable = options.includeUnavailable === true;

    for (let attempt = 0; attempt < this.states.length; attempt += 1) {
      const state = this.pickCandidate(skipped, includeUnavailable);
      if (!state) break;

      // Mark every host we attempt, including hosts whose credentials fail.
      // The callers pass the same set across a full sweep, so a failed host is
      // not retried on every iteration.
      skipped.add(state.location.ip);

      try {
        const credentials = await this.credentialsFor(state);
        const country = state.location.country ? ` (${state.location.country})` : '';
        this.logger.info?.(
          `[proxy] Using ${state.location.ip}:${state.location.port}${country}.`,
        );
        return {
          host: state.location.ip,
          port: state.location.port,
          username: credentials.username,
          password: credentials.password,
          protocol: this.protocol,
          country: state.location.country,
          label: state.location.location,
        };
      } catch (error) {
        if (error instanceof ProxyHostDisabledError) {
          this.logger.error(`[proxy] ${error.message} It stays out of rotation for now.`);
        } else {
          state.authCooldownUntil = this.now() + this.authFailureCooldownMs;
          this.logger.error(
            `[proxy] Could not resolve credentials for ${state.location.ip}:`,
            error,
          );
        }
      }
    }

    throw new ProxyUnavailableError(
      this.lastHost
        ? 'No other proxy host is currently available.'
        : 'No proxy host could be selected.',
    );
  }

  /**
   * Records that a proxy failed. The credentials are dropped so the next use
   * re-resolves them. If they come back unchanged, the host is disabled.
   */
  reportFailure(endpoint: ProxyEndpoint): void {
    const state = this.statesByHost.get(endpoint.host);
    if (!state) return;

    state.lastFailedCredentials = state.credentials ?? {
      username: endpoint.username,
      password: endpoint.password,
    };
    state.credentials = null;
  }

  private pickCandidate(
    exclude: ReadonlySet<string>,
    includeUnavailable: boolean,
  ): HostState | null {
    const now = this.now();

    for (let offset = 0; offset < this.states.length; offset += 1) {
      const index = (this.cursor + offset) % this.states.length;
      const state = this.states[index];
      if (!state) continue;

      const host = state.location.ip;
      if (host === this.lastHost) continue;
      if (exclude.has(host)) continue;
      if (!includeUnavailable) {
        if (state.disabledUntil > now) continue;
        if (state.authCooldownUntil > now) continue;
      }

      this.cursor = (index + 1) % this.states.length;
      this.lastHost = host;
      return state;
    }

    return null;
  }

  private credentialsFor(state: HostState): Promise<Credentials> {
    if (state.credentials) return Promise.resolve(state.credentials);
    if (state.pending) return state.pending;

    const pending = this.fetchCredentials(state.location.ip)
      .then((credentials) => {
        if (
          state.lastFailedCredentials &&
          sameCredentials(credentials, state.lastFailedCredentials)
        ) {
          state.disabledUntil = this.now() + this.hostDisableMs;
          state.credentials = null;
          state.lastFailedCredentials = null;
          throw new ProxyHostDisabledError(state.location.ip);
        }

        state.credentials = credentials;
        state.lastFailedCredentials = null;
        return credentials;
      })
      .finally(() => {
        state.pending = null;
      });

    state.pending = pending;
    return pending;
  }

  private async fetchCredentials(host: string): Promise<Credentials> {
    let firstError: unknown;

    for (const provider of this.authProviders) {
      try {
        const url = new URL(provider);
        url.searchParams.set('action', 'proxyauth');
        url.searchParams.set('ip', host);

        const response = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: { accept: 'text/plain' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          throw new Error(`Proxy auth provider returned HTTP ${response.status}.`);
        }

        // The successful response is the credential itself, used as both the
        // username and the password.
        const credential = (await response.text()).trim();
        if (!isCredentialValue(credential)) {
          throw new Error('Proxy auth provider returned an unexpected credential value.');
        }
        return { username: credential, password: credential };
      } catch (error) {
        firstError ??= error;
      }
    }

    throw new ProxyAuthError(
      `Every proxy auth provider failed for ${host}.`,
      { cause: firstError },
    );
  }
}
