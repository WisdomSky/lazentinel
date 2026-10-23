import { createHash, randomBytes } from 'node:crypto';
import { AuthDatabase, type AuthUserRow } from './auth-db.js';
import {
  ConflictError,
  UnauthorizedError,
  ValidationError,
  isUniqueConstraintError,
} from './errors.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthUser {
  id: number;
  email: string;
}

export interface LoginResult {
  user: AuthUser;
  token: string;
  expiresAt: Date;
}

export interface RegisterInput {
  email: string;
  password: string;
  confirmPassword: string;
}

export interface AuthServiceOptions {
  now?: () => Date;
  sessionTtlMs?: number;
}

export interface AuthServiceLike {
  register(input: RegisterInput): AuthUser;
  login(email: string, password: string): LoginResult;
  getSession(token: string): AuthUser | null;
  logout(token: string): void;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toAuthUser(row: AuthUserRow): AuthUser {
  return { id: row.id, email: row.email };
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Account/session logic. Passwords deliberately remain plaintext in the
 * separate auth database, matching the product requirement.
 */
export class AuthService implements AuthServiceLike {
  private readonly db: AuthDatabase;
  private readonly now: () => Date;
  readonly sessionTtlMs: number;

  constructor(db: AuthDatabase, options: AuthServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.sessionTtlMs = Math.max(60_000, options.sessionTtlMs ?? SESSION_TTL_MS);
  }

  register(input: RegisterInput): AuthUser {
    const email = normalizeEmail(input.email);
    if (!email) throw new ValidationError('Email is required.');
    if (!input.password) throw new ValidationError('Password is required.');
    if (input.password !== input.confirmPassword) {
      throw new ValidationError('Passwords do not match.');
    }
    if (this.db.findUserByEmail(email)) {
      throw new ConflictError('An account with this email already exists.');
    }

    let user: AuthUserRow;
    try {
      user = this.db.createUser(email, input.password, this.now().toISOString());
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictError('An account with this email already exists.');
      }
      throw error;
    }

    return toAuthUser(user);
  }

  login(email: string, password: string): LoginResult {
    const normalizedEmail = normalizeEmail(email);
    const user = this.db.findUserByEmail(normalizedEmail);
    if (!user || user.password !== password) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    const token = randomBytes(32).toString('base64url');
    this.db.deleteExpiredSessions(now.toISOString());
    this.db.createSession(
      hashSessionToken(token),
      user.id,
      now.toISOString(),
      expiresAt.toISOString(),
    );

    return {
      user: toAuthUser(user),
      token,
      expiresAt,
    };
  }

  getSession(token: string): AuthUser | null {
    if (!token) return null;
    const session = this.db.findSession(hashSessionToken(token));
    if (!session) return null;

    if (new Date(session.expiresAt).getTime() <= this.now().getTime()) {
      this.db.deleteSession(hashSessionToken(token));
      return null;
    }

    return { id: session.userId, email: session.email };
  }

  logout(token: string): void {
    if (!token) return;
    this.db.deleteSession(hashSessionToken(token));
  }
}
