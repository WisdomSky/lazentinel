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
