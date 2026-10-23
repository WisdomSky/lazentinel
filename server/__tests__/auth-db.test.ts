import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthDatabase } from '../auth-db.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lazentinel-auth-'));
  tempDirs.push(dir);
  return path.join(dir, 'auth.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('AuthDatabase', () => {
  it('stores the exact plaintext password and finds users case-insensitively', () => {
    const db = new AuthDatabase(':memory:');
    try {
      const created = db.createUser(
        'Mixed@Example.com',
        '  Exact Secret! ',
        '2026-01-01T00:00:00.000Z',
      );

      expect(created.email).toBe('Mixed@Example.com');
      expect(created.password).toBe('  Exact Secret! ');

      const found = db.findUserByEmail('mixed@example.com');
      expect(found).not.toBeNull();
      expect(found?.email).toBe('Mixed@Example.com');
      expect(found?.password).toBe('  Exact Secret! ');
      expect(found?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(db.countUsers()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('creates only auth tables in a separate database file', () => {
    const file = tempDbPath();
    const db = new AuthDatabase(file);
    db.createUser('user@example.com', 'secret', '2026-01-01T00:00:00.000Z');
    db.close();

    const raw = new Database(file, { readonly: true });
    try {
      const rows = raw
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      expect(rows.map((row) => row.name)).toEqual(['sessions', 'users']);
    } finally {
      raw.close();
    }
  });

  it('creates and deletes sessions by their hashed token', () => {
    const db = new AuthDatabase(':memory:');
    try {
      const user = db.createUser('user@example.com', 'secret', '2026-01-01T00:00:00.000Z');
      db.createSession(
        'hash-1',
        user.id,
        '2026-01-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
      );

      expect(db.findSession('hash-1')).toEqual({
        userId: user.id,
        email: 'user@example.com',
        expiresAt: '2026-02-01T00:00:00.000Z',
      });

      db.deleteSession('hash-1');
      expect(db.findSession('hash-1')).toBeNull();
    } finally {
      db.close();
    }
  });
});
