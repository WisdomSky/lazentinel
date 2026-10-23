import { existsSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_TRACKING_INTERVAL_SECONDS = 300;
export const MIN_TRACKING_INTERVAL_SECONDS = 5;
export const MAX_TRACKING_INTERVAL_SECONDS = 86_400;

export interface AppConfig {
  port: number;
  databasePath: string;
  clientDist: string;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (received "${raw}").`);
  }
  return port;
}

function resolveFromCwd(value: string): string {
  return path.resolve(process.cwd(), value);
}

function parseDatabasePath(raw: string | undefined): string {
  const value = raw?.trim() || './data/lazentinel.db';
  // `:memory:` is a SQLite sentinel, not a filesystem path.
  if (value === ':memory:') return value;
  return resolveFromCwd(value);
}

function parseClientDist(raw: string | undefined): string {
  return resolveFromCwd(raw?.trim() || 'client/dist');
}

/**
 * Loads a local `.env` file when present. Values already present in the
 * environment (Docker, shell, npm scripts) are not overwritten.
 */
export function loadLocalEnv(
  filePath: string = path.resolve(process.cwd(), '.env'),
): void {
  if (!existsSync(filePath)) return;
  process.loadEnvFile(filePath);
}

/** Reads server configuration from the environment. Paths are cwd-relative. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: parsePort(env.PORT),
    databasePath: parseDatabasePath(env.DATABASE_PATH),
    clientDist: parseClientDist(env.CLIENT_DIST),
  };
}

export function isValidTrackingInterval(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_TRACKING_INTERVAL_SECONDS &&
    value <= MAX_TRACKING_INTERVAL_SECONDS
  );
}
