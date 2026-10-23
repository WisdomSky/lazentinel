import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Accounts and sessions live in their own SQLite file so they are completely
 * separate from product/price data.
 *
 * IMPORTANT: Per the product requirement, account passwords are stored in
 * plaintext in this database. This is intentionally not production-safe; see
 * the security note in README.md.
 */
export interface AuthUserRow {
  id: number;
  email: string;
  password: string;
  createdAt: string;
}

export interface SessionUserRow {
  userId: number;
  email: string;
  expiresAt: string;
}

const AUTH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);
`;

export class AuthDatabase {
  private readonly sqlite: Database.Database;

  private readonly insertUserStmt: Database.Statement<
    { email: string; password: string; createdAt: string },
    unknown
  >;
  private readonly selectUserByEmailStmt: Database.Statement<[string], AuthUserRow>;
  private readonly insertSessionStmt: Database.Statement<
    { tokenHash: string; userId: number; createdAt: string; expiresAt: string },
    unknown
  >;
  private readonly selectSessionStmt: Database.Statement<[string], SessionUserRow>;
  private readonly deleteSessionStmt: Database.Statement<[string], unknown>;
  private readonly deleteExpiredSessionsStmt: Database.Statement<[string], unknown>;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    this.sqlite = new Database(databasePath);
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    if (databasePath !== ':memory:') {
      this.sqlite.pragma('journal_mode = WAL');
      this.sqlite.pragma('synchronous = NORMAL');
    }
    this.sqlite.exec(AUTH_SCHEMA);
    this.sqlite
      .prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .run(new Date().toISOString());

    this.insertUserStmt = this.sqlite.prepare(`
      INSERT INTO users (email, password, created_at)
      VALUES (@email, @password, @createdAt)
    `);
    this.selectUserByEmailStmt = this.sqlite.prepare<[string], AuthUserRow>(`
      SELECT
        id,
        email,
        password,
        created_at AS createdAt
      FROM users
      WHERE email = ?
    `);
    this.insertSessionStmt = this.sqlite.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
      VALUES (@tokenHash, @userId, @createdAt, @expiresAt)
    `);
    this.selectSessionStmt = this.sqlite.prepare<[string], SessionUserRow>(`
      SELECT
        s.user_id AS userId,
        u.email AS email,
        s.expires_at AS expiresAt
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `);
    this.deleteSessionStmt = this.sqlite.prepare(
      'DELETE FROM sessions WHERE token_hash = ?',
    );
    this.deleteExpiredSessionsStmt = this.sqlite.prepare(
      'DELETE FROM sessions WHERE expires_at <= ?',
    );
  }

  createUser(email: string, password: string, createdAt: string): AuthUserRow {
    // Plaintext storage is deliberate; see the class-level comment.
    this.insertUserStmt.run({ email, password, createdAt });
    const user = this.findUserByEmail(email);
    if (!user) throw new Error('User was not found after insert.');
    return user;
  }

  findUserByEmail(email: string): AuthUserRow | null {
    return this.selectUserByEmailStmt.get(email) ?? null;
  }

  createSession(
    tokenHash: string,
    userId: number,
    createdAt: string,
    expiresAt: string,
  ): void {
    this.insertSessionStmt.run({ tokenHash, userId, createdAt, expiresAt });
  }

  findSession(tokenHash: string): SessionUserRow | null {
    return this.selectSessionStmt.get(tokenHash) ?? null;
  }

  deleteSession(tokenHash: string): void {
    this.deleteSessionStmt.run(tokenHash);
  }

  deleteExpiredSessions(nowIso: string): void {
    this.deleteExpiredSessionsStmt.run(nowIso);
  }

  countUsers(): number {
    const row = this.sqlite
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM users')
      .get();
    return row?.count ?? 0;
  }

  close(): void {
    if (this.sqlite.open) this.sqlite.close();
  }
}
