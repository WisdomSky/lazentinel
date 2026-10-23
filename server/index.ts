import { createApp } from './app.js';
import { LazadaBrowserRenderer } from './browser-renderer.js';
import { loadConfig, loadLocalEnv } from './config.js';
import { AppDatabase } from './db.js';
import { LazadaScraper } from './scraper.js';
import { ProductService } from './service.js';

function main(): void {
  loadLocalEnv();
  const config = loadConfig(process.env);
  const db = new AppDatabase(config.databasePath);
  const renderer = new LazadaBrowserRenderer({ logger: console });
  const scraper = new LazadaScraper({ renderer });
  const service = new ProductService(db, scraper);
  const app = createApp({ service, clientDir: config.clientDist });

  service.start();

  const server = app.listen(config.port, () => {
    const { trackingIntervalSeconds } = service.getSettings();
    console.info(`[server] Lazentinel listening on http://localhost:${config.port}`);
    console.info(`[server] Database: ${config.databasePath}`);
    console.info(`[server] Tracking interval: ${trackingIntervalSeconds}s`);
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
    process.exit(1);
  });
}

main();
