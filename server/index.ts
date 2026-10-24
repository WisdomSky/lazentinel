import { createApp } from './app.js';
import { AuthDatabase } from './auth-db.js';
import { AuthService } from './auth.js';
import { LazadaBrowserRenderer } from './browser-renderer.js';
import { loadConfig, loadLocalEnv } from './config.js';
import { AppDatabase } from './db.js';
import { ProxyResolver } from './proxy/proxy_resolver.js';
import { LazadaScraper } from './scraper.js';
import { ProductService } from './service.js';
import { TwoCaptchaBrowser } from './twocaptcha.js';

function main(): void {
  loadLocalEnv();
  const config = loadConfig(process.env);
  const db = new AppDatabase(config.databasePath, {
    trackingIntervalSeconds: config.trackingIntervalSeconds,
  });
  const authDb = config.multiUser ? new AuthDatabase(config.authDatabasePath) : null;
  const auth = authDb ? new AuthService(authDb) : null;

  // A manual single proxy takes precedence; otherwise rotate through the
  // location list and resolve credentials from the auth providers.
  const staticProxy = process.env.CLOAKBROWSER_PROXY?.trim();
  const proxyEnabled =
    process.env.PROXY_ENABLED?.trim().toLowerCase() !== 'false' && !staticProxy;
  const proxyResolver = proxyEnabled ? new ProxyResolver({ logger: console }) : null;
  if (proxyResolver) {
    console.info(`[proxy] Rotating across ${proxyResolver.size} proxy hosts.`);
  } else if (staticProxy) {
    console.info('[proxy] Using the single proxy from CLOAKBROWSER_PROXY.');
  } else {
    console.info('[proxy] Disabled; Lazada requests go out directly.');
  }

  const fallback = new TwoCaptchaBrowser({
    logger: console,
    proxyProvider: proxyResolver,
  });
  if (!fallback.configured) {
    console.info(
      '[2captcha] Browser API fallback disabled (TWOCAPTCHA_API_KEY is not set).',
    );
  } else if (proxyResolver) {
    console.info(
      '[2captcha] Browser API fallback enabled after every proxy host fails.',
    );
  } else {
    console.info(
      '[2captcha] Browser API key is set, but the fallback needs the rotating proxy pool.',
    );
  }

  const renderer = new LazadaBrowserRenderer({
    logger: console,
    proxyResolver,
    fallback,
  });
  const scraper = new LazadaScraper({ renderer });
  const service = new ProductService(db, scraper);
  const app = createApp({
    service,
    clientDir: config.clientDist,
    multiUser: config.multiUser,
    auth,
    cookieSecure: config.cookieSecure,
  });

  service.start();

  const server = app.listen(config.port, () => {
    const { trackingIntervalSeconds } = service.getSettings();
    console.info(`[server] Lazentinel listening on http://localhost:${config.port}`);
    console.info(`[server] Database: ${config.databasePath}`);
    console.info(`[server] Tracking interval: ${trackingIntervalSeconds}s`);
    console.info(
      `[server] Multi-user mode: ${config.multiUser ? 'enabled' : 'disabled'}`,
    );
    if (config.multiUser) {
      console.info(`[server] Auth database: ${config.authDatabasePath}`);
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals | string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[server] ${signal} received — shutting down.`);
    service.stop();

    const forceTimer = setTimeout(() => {
      console.error('[server] Graceful shutdown timed out; forcing exit.');
      try {
        db.close();
      } catch {
        // The database may already be closed.
      }
      try {
        authDb?.close();
      } catch {
        // The auth database may already be closed.
      }
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    server.close((error) => {
      void (async () => {
        try {
          await scraper.close();
        } catch (closeError) {
          console.error('[server] Failed to close the browser renderer:', closeError);
        }
        try {
          db.close();
        } catch (closeError) {
          console.error('[server] Failed to close database:', closeError);
        }
        try {
          authDb?.close();
        } catch (closeError) {
          console.error('[server] Failed to close auth database:', closeError);
        }
        clearTimeout(forceTimer);
        if (error) {
          console.error('[server] Failed to close HTTP server:', error);
          process.exit(1);
        }
        process.exit(0);
      })();
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled promise rejection:', reason);
  });

  server.on('error', (error) => {
    console.error('[server] HTTP server error:', error);
    service.stop();
    void scraper.close().catch(() => undefined);
    try {
      db.close();
    } catch {
      // The database may already be closed.
    }
    try {
      authDb?.close();
    } catch {
      // The auth database may already be closed.
    }
    process.exit(1);
  });
}

main();
