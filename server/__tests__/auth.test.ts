import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthDatabase } from '../auth-db.js';
import { AuthService } from '../auth.js';
import { ConflictError, UnauthorizedError, ValidationError } from '../errors.js';
import { createClock } from './helpers/fakes.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lazentinel-auth-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'auth.db');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('AuthService', () => {
  it('registers a normalized public user and stores the plaintext password', () => {
    const db = new AuthDatabase(':memory:');
    try {
      const service = new AuthService(db);
      const user = service.register({
        email: '  Alice@Example.COM ',
        password: '  Exact Secret! ',
        confirmPassword: '  Exact Secret! ',
      });

      expect(user).toEqual({ id: 1, email: 'alice@example.com' });
      expect(Object.keys(user).sort()).toEqual(['email', 'id']);
      expect(db.findUserByEmail('ALICE@example.com')?.password).toBe('  Exact Secret! ');
      expect(db.countUsers()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rejects mismatched confirmation and case-insensitive duplicate emails', () => {
    const db = new AuthDatabase(':memory:');
    try {
      const service = new AuthService(db);

      expect(() =>
        service.register({
          email: 'bob@example.com',
          password: 'one',
          confirmPassword: 'two',
        }),
      ).toThrow(ValidationError);
      expect(db.countUsers()).toBe(0);

      service.register({
        email: 'alice@example.com',
        password: 'secret',
        confirmPassword: 'secret',
      });
      expect(() =>
        service.register({
          email: 'ALICE@EXAMPLE.COM',
          password: 'other',
          confirmPassword: 'other',
        }),
      ).toThrow(ConflictError);
      expect(db.countUsers()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rejects unknown emails and wrong passwords with the same generic error', () => {
    const db = new AuthDatabase(':memory:');
    try {
      const service = new AuthService(db);
      service.register({
        email: 'alice@example.com',
        password: 'secret',
        confirmPassword: 'secret',
      });

      const messages: string[] = [];
      for (const attempt of [
        { email: 'unknown@example.com', password: 'secret' },
        { email: 'alice@example.com', password: 'wrong' },
      ]) {
        try {
          service.login(attempt.email, attempt.password);
          throw new Error('Expected login to fail.');
        } catch (error) {
          expect(error).toBeInstanceOf(UnauthorizedError);
          messages.push((error as Error).message);
        }
      }

      expect(messages).toEqual(['Invalid email or password.', 'Invalid email or password.']);
    } finally {
      db.close();
    }
  });

  it('creates a session from a raw token that is stored only as a hash', () => {
    const file = tempDbPath();
    const db = new AuthDatabase(file);
    const service = new AuthService(db);
    const user = service.register({
      email: 'alice@example.com',
      password: 'secret',
      confirmPassword: 'secret',
    });
    const login = service.login('alice@example.com', 'secret');
    const expectedHash = hashToken(login.token);

    expect(login.user).toEqual(user);
    expect(login.token.length).toBeGreaterThan(20);
    expect(login.token).not.toBe(expectedHash);
    expect(service.getSession(login.token)).toEqual(user);
    expect(db.findSession(expectedHash)?.userId).toBe(user.id);
    db.close();

    const raw = new Database(file, { readonly: true });
    try {
      const rows = raw
        .prepare<[], { token_hash: string }>('SELECT token_hash FROM sessions')
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.token_hash).toBe(expectedHash);
      expect(rows[0]?.token_hash).not.toBe(login.token);
    } finally {
      raw.close();
    }
  });

  it('invalidates a session on logout', () => {
    const db = new AuthDatabase(':memory:');
    try {
      const service = new AuthService(db);
      service.register({
        email: 'alice@example.com',
        password: 'secret',
        confirmPassword: 'secret',
      });
      const login = service.login('alice@example.com', 'secret');

      expect(service.getSession(login.token)).not.toBeNull();
      service.logout(login.token);
      expect(service.getSession(login.token)).toBeNull();
      expect(db.findSession(hashToken(login.token))).toBeNull();

      expect(() => service.logout(login.token)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('expires sessions using the injected clock', () => {
    const clock = createClock('2026-01-01T00:00:00.000Z');
    const db = new AuthDatabase(':memory:');
    try {
      const service = new AuthService(db, {
        now: clock.now,
        sessionTtlMs: 60_000,
      });
      service.register({
        email: 'alice@example.com',
        password: 'secret',
        confirmPassword: 'secret',
      });
      const login = service.login('alice@example.com', 'secret');

      expect(login.expiresAt.toISOString()).toBe('2026-01-01T00:01:00.000Z');

      clock.advance(59_999);
      expect(service.getSession(login.token)).not.toBeNull();

      clock.advance(1);
      expect(service.getSession(login.token)).toBeNull();
      expect(db.findSession(hashToken(login.token))).toBeNull();
    } finally {
      db.close();
    }
  });
});
