import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const cwd = process.cwd();

describe('loadConfig multi-user settings', () => {
  it('enables multi-user mode only when ENABLE_MULTIUSER is exactly "true"', () => {
    expect(loadConfig({}).multiUser).toBe(false);
    expect(loadConfig({ ENABLE_MULTIUSER: 'true' }).multiUser).toBe(true);

    for (const value of ['TRUE', 'True', '1', 'yes', 'on', 'true ', ' true', 'false', '']) {
      expect(loadConfig({ ENABLE_MULTIUSER: value }).multiUser).toBe(false);
    }
  });

  it('enables secure cookies only when COOKIE_SECURE is exactly "true"', () => {
    expect(loadConfig({}).cookieSecure).toBe(false);
    expect(loadConfig({ COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);

    for (const value of ['TRUE', '1', 'yes', 'false', '']) {
      expect(loadConfig({ COOKIE_SECURE: value }).cookieSecure).toBe(false);
    }
  });

  it('defaults the auth database to ./data/lazentinel-auth.db', () => {
    expect(loadConfig({}).authDatabasePath).toBe(
      path.resolve(cwd, 'data/lazentinel-auth.db'),
    );
    expect(loadConfig({ AUTH_DATABASE_PATH: '' }).authDatabasePath).toBe(
      path.resolve(cwd, 'data/lazentinel-auth.db'),
    );
    expect(loadConfig({ AUTH_DATABASE_PATH: '   ' }).authDatabasePath).toBe(
      path.resolve(cwd, 'data/lazentinel-auth.db'),
    );
  });

  it('resolves relative auth paths from the cwd and keeps absolute paths', () => {
    expect(loadConfig({ AUTH_DATABASE_PATH: './data/custom-auth.db' }).authDatabasePath).toBe(
      path.resolve(cwd, 'data/custom-auth.db'),
    );

    const absolute = path.join(cwd, 'tmp', 'absolute-auth.db');
    expect(loadConfig({ AUTH_DATABASE_PATH: absolute }).authDatabasePath).toBe(absolute);
    expect(loadConfig({ AUTH_DATABASE_PATH: ':memory:' }).authDatabasePath).toBe(':memory:');
  });

  it('keeps the product database default and absolute paths', () => {
    expect(loadConfig({}).databasePath).toBe(path.resolve(cwd, 'data/lazentinel.db'));
    expect(loadConfig({ DATABASE_PATH: ':memory:' }).databasePath).toBe(':memory:');

    const absolute = path.join(cwd, 'tmp', 'absolute-products.db');
    expect(loadConfig({ DATABASE_PATH: absolute }).databasePath).toBe(absolute);
  });
});

describe('loadConfig default tracking interval', () => {
  it('falls back to 5 minutes when unset or empty', () => {
    expect(loadConfig({}).defaultTrackingIntervalSeconds).toBe(300);
    expect(loadConfig({}).defaultTrackingIntervalFromEnv).toBe(false);
    expect(
      loadConfig({ DEFAULT_TRACKING_INTERVAL_MINUTES: '' })
        .defaultTrackingIntervalSeconds,
    ).toBe(300);
    expect(
      loadConfig({ DEFAULT_TRACKING_INTERVAL_MINUTES: '' })
        .defaultTrackingIntervalFromEnv,
    ).toBe(false);
    expect(
      loadConfig({ DEFAULT_TRACKING_INTERVAL_MINUTES: '   ' })
        .defaultTrackingIntervalSeconds,
    ).toBe(300);
    expect(
      loadConfig({ DEFAULT_TRACKING_INTERVAL_MINUTES: '   ' })
        .defaultTrackingIntervalFromEnv,
    ).toBe(false);
  });

  it('converts a custom value from minutes to seconds', () => {
    expect(
      loadConfig({ DEFAULT_TRACKING_INTERVAL_MINUTES: '5' })
        .defaultTrackingIntervalSeconds,
    ).toBe(300);
    expect(
      loadConfig({ DEFAULT_TRACKING_INTERVAL_MINUTES: '5' })
        .defaultTrackingIntervalFromEnv,
    ).toBe(true);
    expect(
      loadConfig({ DEFAULT_TRACKING_INTERVAL_MINUTES: '10' })
        .defaultTrackingIntervalSeconds,
    ).toBe(600);
    expect(
      loadConfig({ DEFAULT_TRACKING_INTERVAL_MINUTES: '0.5' })
        .defaultTrackingIntervalSeconds,
    ).toBe(30);
    expect(
      loadConfig({ DEFAULT_TRACKING_INTERVAL_MINUTES: '5.5' })
        .defaultTrackingIntervalSeconds,
    ).toBe(330);
    expect(
      loadConfig({ DEFAULT_TRACKING_INTERVAL_MINUTES: '1440' })
        .defaultTrackingIntervalSeconds,
    ).toBe(86_400);
    expect(
      loadConfig({ DEFAULT_TRACKING_INTERVAL_MINUTES: '0.0833' })
        .defaultTrackingIntervalSeconds,
    ).toBe(5);
  });

  it.each(['0', '-1', '1441', '0.01', 'abc', 'NaN', 'Infinity'])(
    'rejects invalid value %j',
    (value) => {
      expect(() =>
        loadConfig({ DEFAULT_TRACKING_INTERVAL_MINUTES: value }),
      ).toThrow(/DEFAULT_TRACKING_INTERVAL_MINUTES/);
    },
  );
});
