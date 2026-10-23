import { existsSync } from 'node:fs';
import path from 'node:path';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  ScrapeError,
  ValidationError,
} from './errors.js';
import type { ProductServiceLike } from './service.js';

export interface CreateAppOptions {
  service: ProductServiceLike;
  clientDir?: string;
}

const addProductSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, 'url is required')
    .max(2048, 'url must be 2048 characters or fewer'),
});

const settingsSchema = z.object({
  trackingIntervalSeconds: z
    .number()
    .int('trackingIntervalSeconds must be an integer')
    .min(5, 'trackingIntervalSeconds must be at least 5')
    .max(86_400, 'trackingIntervalSeconds must be at most 86400'),
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request body.';
  const field = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${field}${issue.message}`;
}

function parseProductId(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

interface HttpishError {
  status?: number;
  statusCode?: number;
  type?: string;
  message?: string;
}

function asHttpishError(error: unknown): HttpishError | null {
  return typeof error === 'object' && error !== null ? (error as HttpishError) : null;
}

export function createApp({ service, clientDir }: CreateAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/products', async (_req, res) => {
    const products = await service.listProducts();
    res.json({ products });
  });

  app.post('/api/products', async (req, res) => {
    const parsed = addProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    const result = await service.addProduct(parsed.data.url);
    res.status(201).json(result);
  });

  app.delete('/api/products/:id', async (req, res) => {
    const id = parseProductId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Product id must be a positive integer.' });
      return;
    }

    const deleted = await service.deleteProduct(id);
    if (!deleted) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }
    res.status(204).end();
  });

  app.post('/api/products/:id/refresh', async (req, res) => {
    const id = parseProductId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Product id must be a positive integer.' });
      return;
    }

    const result = await service.refreshProduct(id);
    if (!result) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }
    res.json(result);
  });

  app.get('/api/settings', async (_req, res) => {
    const settings = await service.getSettings();
    res.json(settings);
  });

  app.put('/api/settings', async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    const settings = await service.updateSettings(parsed.data);
    res.json(settings);
  });

  // Every unmatched /api route is a JSON 404, never the SPA shell.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  if (clientDir) {
    const resolvedClientDir = path.resolve(clientDir);
    app.use(express.static(resolvedClientDir, { index: 'index.html' }));

    // Express 5 no longer accepts app.get('*'); a middleware handles the SPA
    // fallback. Asset-like paths are excluded so a missing image is a real
    // 404 instead of an HTML page with a 200 status. When the client build is
    // absent, requests fall through to 404.
    app.use((req, res, next) => {
      const looksLikeAsset =
        req.path.startsWith('/assets/') || path.extname(req.path) !== '';
      if (req.method !== 'GET' || req.path.startsWith('/api') || looksLikeAsset) {
        next();
        return;
      }
      const indexFile = path.join(resolvedClientDir, 'index.html');
      if (!existsSync(indexFile)) {
        next();
        return;
      }
      res.sendFile(indexFile, (error) => {
        if (error) next(error);
      });
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof ScrapeError) {
      const status = error.code === 'INVALID_URL' ? 400 : 422;
      res.status(status).json({ error: error.message });
      return;
    }
    if (error instanceof ConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof NotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }

    const httpError = asHttpishError(error);
    if (httpError?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Request body must be valid JSON.' });
      return;
    }
    if (httpError?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body is too large.' });
      return;
    }

    console.error('[api] Unhandled error:', error);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}
