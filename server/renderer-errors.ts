/**
 * Renderer errors shared by the browser renderer and the scraper. Kept in a
 * leaf module so the scraper does not need to import the renderer itself.
 */

export class BrowserRenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BrowserRenderError';
  }
}

/** Lazada served its bot-challenge page instead of the product. */
export class BotChallengeError extends BrowserRenderError {
  constructor(message = 'Lazada presented a bot challenge.') {
    super(message);
    this.name = 'BotChallengeError';
  }
}

/**
 * No proxy could load the product. The renderer stops trying this URL until
 * `retryAt`, so callers must not fall back to a direct request.
 */
export class RenderBlockedError extends BrowserRenderError {
  readonly retryAt: number;

  constructor(message: string, retryAt: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RenderBlockedError';
    this.retryAt = retryAt;
  }
}

export function isRenderBlockedError(error: unknown): error is RenderBlockedError {
  return error instanceof RenderBlockedError;
}
