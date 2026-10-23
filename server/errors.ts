/**
 * Typed domain errors. HTTP status mapping lives in `app.ts` so the service and
 * scraper stay transport agnostic.
 */

export type ScrapeErrorCode =
  | 'INVALID_URL'
  | 'NOT_FOUND'
  | 'BLOCKED'
  | 'NETWORK'
  | 'PARSE';

export class ScrapeError extends Error {
  readonly code: ScrapeErrorCode;

  constructor(code: ScrapeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScrapeError';
    this.code = code;
  }
}

export function isScrapeError(error: unknown): error is ScrapeError {
  return error instanceof ScrapeError;
}

/** A request that conflicts with existing state (duplicate product). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Input that failed validation outside of the HTTP schema layer. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** A requested entity does not exist. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Missing, invalid or expired authentication. */
export class UnauthorizedError extends Error {
  constructor(message = 'Authentication required.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** Prevents a database unique constraint from looking like a 500. */
export function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    return code.includes('UNIQUE');
  }
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
