import type {
  ProductRenderer,
  RenderRequest,
  RenderedProduct,
} from './browser-renderer.js';
import { isScrapeError, ScrapeError } from './errors.js';

export { ScrapeError };
export type { ScrapeErrorCode } from './errors.js';

export interface Marketplace {
  domain: string;
  currency: string;
  acceptLanguage: string;
  home: string;
  locale: string;
  timezone: string;
}

export const MARKETPLACES: readonly Marketplace[] = [
  {
    domain: 'lazada.sg',
    currency: 'SGD',
    acceptLanguage: 'en-SG,en;q=0.9',
    home: 'https://www.lazada.sg/',
    locale: 'en-SG',
    timezone: 'Asia/Singapore',
  },
  {
    domain: 'lazada.com.my',
    currency: 'MYR',
    acceptLanguage: 'en-MY,en;q=0.9,ms;q=0.8',
    home: 'https://www.lazada.com.my/',
    locale: 'en-MY',
    timezone: 'Asia/Kuala_Lumpur',
  },
  {
    domain: 'lazada.co.th',
    currency: 'THB',
    acceptLanguage: 'th-TH,th;q=0.9,en;q=0.8',
    home: 'https://www.lazada.co.th/',
    locale: 'th-TH',
    timezone: 'Asia/Bangkok',
  },
  {
    domain: 'lazada.com.ph',
    currency: 'PHP',
    acceptLanguage: 'en-PH,en;q=0.9',
    home: 'https://www.lazada.com.ph/',
    locale: 'en-PH',
    timezone: 'Asia/Manila',
  },
  {
    domain: 'lazada.co.id',
    currency: 'IDR',
    acceptLanguage: 'id-ID,id;q=0.9,en;q=0.8',
    home: 'https://www.lazada.co.id/',
    locale: 'id-ID',
    timezone: 'Asia/Jakarta',
  },
  {
    domain: 'lazada.vn',
    currency: 'VND',
    acceptLanguage: 'vi-VN,vi;q=0.9,en;q=0.8',
    home: 'https://www.lazada.vn/',
    locale: 'vi-VN',
    timezone: 'Asia/Ho_Chi_Minh',
  },
] as const;

export interface NormalizedLazadaUrl {
  url: string;
  hostname: string;
  marketplace: Marketplace;
  isShare: boolean;
}

export interface ScrapedProduct {
  url: string;
  title: string;
  brand: string | null;
  rating: number | null;
  reviewCount: number | null;
  currency: string;
  imageUrl: string | null;
  price: number | null;
  sku: string | null;
}

export interface ScrapeResult {
  product: ScrapedProduct;
  warning?: string;
}

export interface ScraperLike {
  scrape(inputUrl: string): Promise<ScrapeResult>;
}

export interface ParsedPage {
  title: string | null;
  brand: string | null;
  rating: number | null;
  reviewCount: number | null;
  currency: string | null;
  imageUrl: string | null;
  price: number | null;
  priceText: string | null;
  canonicalUrl: string | null;
  sku: string | null;
}

export interface LazadaScraperOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * When provided, the displayed sale price and review summary are read from
   * Lazada's client-side PDP data through this renderer. The HTML fallback is
   * then used only for metadata; its `pdt_price` is not trusted because for
   * discounted items it is the struck-through original price.
   */
  renderer?: ProductRenderer | null;
}

export const DISPLAYED_PRICE_UNAVAILABLE_WARNING =
  "Couldn't read the current displayed price from Lazada. Retrying automatically.";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function firstValue<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export function findMarketplace(hostname: string): Marketplace | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const marketplace of MARKETPLACES) {
    if (host === marketplace.domain || host.endsWith(`.${marketplace.domain}`)) {
      return marketplace;
    }
  }
  return null;
}

/**
 * Validates and canonicalises a Lazada URL. Query strings and fragments are
 * stripped because Lazada appends tracking parameters to shared links.
 */
export function normalizeLazadaUrl(input: string): NormalizedLazadaUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ScrapeError('INVALID_URL', 'Enter a Lazada product URL.');
  }

  let candidate = trimmed;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ScrapeError('INVALID_URL', 'That is not a valid URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ScrapeError('INVALID_URL', 'Only http and https URLs are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new ScrapeError('INVALID_URL', 'URLs containing credentials are not allowed.');
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new ScrapeError('INVALID_URL', 'Only standard http and https ports are allowed.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const marketplace = findMarketplace(hostname);
  if (!marketplace) {
    throw new ScrapeError(
      'INVALID_URL',
      'Only Lazada URLs are supported (lazada.sg, lazada.com.my, lazada.co.th, lazada.com.ph, lazada.co.id, lazada.vn).',
    );
  }

  const pathname = parsed.pathname || '/';
  const lowerPath = pathname.toLowerCase();
  // Lazada share links use both /s/abc and /s.abc forms, depending on the
  // marketplace and share surface.
  const isShare = /^\/s[./][^/]+/i.test(pathname);

  if (isShare) {
    // The shape check above is sufficient; the fetch will follow the redirect.
  } else if (!lowerPath.includes('/products/') || !lowerPath.endsWith('.html')) {
    throw new ScrapeError(
      'INVALID_URL',
      'That URL does not look like a Lazada product page. Paste the product URL containing /products/ and ending in .html.',
    );
  }

  // Scheme is always upgraded to https, and all query/fragment tracking is dropped.
  return {
    url: `https://${hostname}${pathname}`,
    hostname,
    marketplace,
    isShare,
  };
}

/** Returns the canonical product URL, or null for share links / invalid URLs. */
export function canonicalizeLazadaProductUrl(candidate: string): string | null {
  try {
    const normalized = normalizeLazadaUrl(candidate);
    return normalized.isShare ? null : normalized.url;
  } catch {
    return null;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

function cleanTitle(value: string | null): string | null {
  if (!value) return null;
  const decoded = collapseWhitespace(decodeHtmlEntities(value));
  const stripped = collapseWhitespace(
    decoded
      .replace(/\s*\|\s*Lazada\b.*$/i, '')
      .replace(/\s+[-–—]\s+Lazada\b.*$/i, ''),
  );
  if (!stripped || /^lazada$/i.test(stripped)) return null;
  if (
    /^(?:(?:page|product)\s+)?not\s+found$|^404\b|^error\b|^access\s+denied$|^forbidden$/i.test(
      stripped,
    )
  ) {
    return null;
  }
  return stripped;
}

function cleanBrand(value: string | null): string | null {
  if (!value) return null;
  const cleaned = collapseWhitespace(decodeHtmlEntities(value));
  if (!cleaned || /^(no[\s-]?brand|unbranded|generic)$/i.test(cleaned)) return null;
  return cleaned;
}

/** Parses a display price such as "$42.00", "RM 129.00", "฿1,290" or "Rp 1.234.000". */
export function parsePrice(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;

  // Reject negative amounts regardless of currency prefix or the minus glyph
  // used ("$-42", "USD -5", "−42.00"). Only the prefix before the first digit
  // matters; the value itself may contain separators.
  const firstDigit = value.search(/\d/);
  if (firstDigit > 0 && /[-\u2212\u2013\u2014]/.test(value.slice(0, firstDigit))) {
    return null;
  }

  const match = value.match(/\d[\d.,\s'’]*/);
  if (!match) return null;

  let numeric = match[0].replace(/[\s'’]/g, '');
  numeric = numeric.replace(/[.,]+$/, '');
  if (!numeric) return null;

  const hasDot = numeric.includes('.');
  const hasComma = numeric.includes(',');

  if (hasDot && hasComma) {
    const lastDot = numeric.lastIndexOf('.');
    const lastComma = numeric.lastIndexOf(',');
    if (lastComma > lastDot) {
      // 1.234,56 — dots group, comma is the decimal separator.
      numeric = numeric.replace(/\./g, '').replace(/,/g, '.');
    } else {
      // 1,234.56 — commas group.
      numeric = numeric.replace(/,/g, '');
    }
  } else if (hasDot || hasComma) {
    const separator = hasDot ? '.' : ',';
    const parts = numeric.split(separator);
    if (parts.length > 2) {
      // Repeated separators can only be grouping separators (1.234.000).
      numeric = parts.join('');
    } else {
      const integerPart = parts[0] ?? '';
      const fractionPart = parts[1] ?? '';
      if (fractionPart.length === 3) {
        // "1,290" / "1.234" are thousands, not three decimal places.
        numeric = `${integerPart}${fractionPart}`;
      } else if (fractionPart.length === 0) {
        numeric = integerPart;
      } else if (fractionPart.length <= 2) {
        numeric = `${integerPart}.${fractionPart}`;
      } else {
        // Four or more digits after the separator cannot be a thousands group
        // (groups are exactly three digits), so treat it as a decimal value.
        numeric = `${integerPart}.${fractionPart}`;
      }
    }
  }

  numeric = numeric.replace(/[^0-9.]/g, '');
  if (!numeric || numeric === '.') return null;
  const parsed = Number(numeric);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseDecimal(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/);
  if (!normalized) return null;
  const parsed = Number(normalized[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRating(value: unknown): number | null {
  const parsed = parseDecimal(value);
  if (parsed === null || parsed < 0 || parsed > 5) return null;
  return Math.round(parsed * 100) / 100;
}

function parseReviewCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([\d.,\s]+)\s*([km])?$/i);
  if (!match) return null;
  const suffix = (match[2] ?? '').toLowerCase();
  const raw = (match[1] ?? '').replace(/\s+/g, '');
  if (!raw) return null;

  let base: number;
  if (suffix) {
    const parts = raw.split(/[.,]/).filter(Boolean);
    base =
      parts.length === 2 && (parts[1]?.length ?? 0) <= 2
        ? Number.parseFloat(`${parts[0]}.${parts[1]}`)
        : Number.parseFloat(raw.replace(/[.,]/g, ''));
  } else {
    base = Number.parseFloat(raw.replace(/[.,]/g, ''));
  }

  if (!Number.isFinite(base) || base < 0) return null;
  const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1;
  return Math.round(base * multiplier);
}

function parseCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function normalizeWebUrl(value: unknown, base?: string): string | null {
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw) return null;
  if (raw.startsWith('//')) raw = `https:${raw}`;
  let resolvedBase: string | undefined;
  if (base) {
    try {
      new URL(base);
      resolvedBase = base;
    } catch {
      resolvedBase = undefined;
    }
  }
  try {
    const url = new URL(raw, resolvedBase);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeCanonicalUrl(value: unknown, base?: string): string | null {
  const normalized = normalizeWebUrl(value, base);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function imageFromValue(value: unknown, base?: string, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === 'string') return normalizeWebUrl(value, base);
  if (Array.isArray(value)) {
    for (const item of value) {
      const image = imageFromValue(item, base, depth + 1);
      if (image) return image;
    }
    return null;
  }
  if (!isObject(value)) return null;
  for (const key of ['url', 'imageUrl', 'src', 'contentUrl', 'image']) {
    const image = imageFromValue(value[key], base, depth + 1);
    if (image) return image;
  }
  for (const key of ['images', 'thumbnails', 'gallery', 'skuGalleries', 'skuInfos']) {
    const image = imageFromValue(value[key], base, depth + 1);
    if (image) return image;
  }
  // skuGalleries is sometimes a map keyed by SKU id.
  for (const child of Object.values(value)) {
    if (!Array.isArray(child) && !isObject(child)) continue;
    const image = imageFromValue(child, base, depth + 1);
    if (image) return image;
  }
  return null;
}

function brandFromValue(value: unknown): string | null {
  if (typeof value === 'string') return cleanBrand(value);
  const object = asObject(value);
  if (!object) return null;
  return cleanBrand(asTrimmedString(object.name) ?? asTrimmedString(object.brandName));
}

function priceFromValue(value: unknown): number | null {
  if (isObject(value)) {
    for (const key of ['price', 'value', 'amount', 'pdt_price', 'salePrice', 'formattedPrice']) {
      const price = priceFromValue(value[key]);
      if (price !== null) return price;
    }
    return null;
  }
  return parsePrice(value);
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const regex = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(tag)) !== null) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function extractMetaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const key = (
      attributes.property ??
      attributes.name ??
      attributes.itemprop ??
      ''
    ).toLowerCase();
    const content = attributes.content;
    if (key && content !== undefined && !tags.has(key)) {
      tags.set(key, content);
    }
  }
  return tags;
}

function extractTitleTag(html: string): string | null {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? cleanTitle(match[1]) : null;
}

function extractCanonicalLink(html: string): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const rel = (attributes.rel ?? '').toLowerCase();
    if (rel.split(/\s+/).includes('canonical') && attributes.href) {
      return normalizeCanonicalUrl(attributes.href);
    }
  }
  return null;
}

/** String-aware brace matcher used to lift JSON out of an inline script. */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function extractModuleData(html: string): unknown | null {
  const marker = '__moduleData__';
  let searchFrom = 0;

  while (searchFrom < html.length) {
    const markerIndex = html.indexOf(marker, searchFrom);
    if (markerIndex < 0) return null;
    const braceIndex = html.indexOf('{', markerIndex + marker.length);
    if (braceIndex < 0) return null;

    // Do not walk into a completely separate <script> block.
    const scriptEnd = html.indexOf('</script', markerIndex);
    if (scriptEnd >= 0 && braceIndex > scriptEnd) {
      searchFrom = markerIndex + marker.length;
      continue;
    }

    const end = findMatchingBrace(html, braceIndex);
    if (end > braceIndex) {
      try {
        return JSON.parse(html.slice(braceIndex, end + 1)) as unknown;
      } catch {
        // Some pages contain more than one assignment; keep looking.
      }
    }
    searchFrom = markerIndex + marker.length;
  }
  return null;
}

function isProductType(value: unknown): boolean {
  const types = Array.isArray(value) ? value : [value];
  return types.some(
    (type) =>
      typeof type === 'string' &&
      (type === 'Product' || type.endsWith('/Product') || type.endsWith('#Product')),
  );
}

function collectJsonLdProducts(value: unknown, output: JsonObject[], depth = 0): void {
  if (depth > 15) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdProducts(item, output, depth + 1);
    return;
  }
  if (!isObject(value)) return;

  if (isProductType(value['@type']) || isProductType(value.itemtype)) {
    output.push(value);
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child) || isObject(child)) {
      collectJsonLdProducts(child, output, depth + 1);
    }
  }
}

interface JsonLdData {
  name: string | null;
  brand: string | null;
  imageUrl: string | null;
  price: number | null;
  currency: string | null;
  rating: number | null;
  reviewCount: number | null;
  url: string | null;
}

function offerData(offersValue: unknown): {
  price: number | null;
  currency: string | null;
} {
  const offers = Array.isArray(offersValue) ? offersValue : [offersValue];
  let price: number | null = null;
  let currency: string | null = null;

  for (const offerValue of offers) {
    const offer = asObject(offerValue);
    if (!offer) continue;
    const specification = asObject(offer.priceSpecification);
    price = firstValue(
      price,
      priceFromValue(offer.price),
      priceFromValue(offer.lowPrice),
      priceFromValue(offer.highPrice),
      priceFromValue(specification?.price),
    );
    currency = firstValue(
      currency,
      parseCurrency(offer.priceCurrency),
      parseCurrency(specification?.priceCurrency),
    );
  }
  return { price, currency };
}

function extractJsonLd(html: string, baseUrl: string): JsonLdData {
  const result: JsonLdData = {
    name: null,
    brand: null,
    imageUrl: null,
    price: null,
    currency: null,
    rating: null,
    reviewCount: null,
    url: null,
  };

  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? '';
    if (
      !/type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)/i.test(
        attributes,
      )
    ) {
      continue;
    }

    let raw = (match[2] ?? '').trim();
    raw = raw.replace(/^<!--/, '').replace(/-->$/, '').trim();
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }

    const products: JsonObject[] = [];
    collectJsonLdProducts(parsed, products);

    for (const product of products) {
      result.name = firstValue(result.name, cleanTitle(asTrimmedString(product.name)));
      result.brand = firstValue(result.brand, brandFromValue(product.brand));
      result.imageUrl = firstValue(result.imageUrl, imageFromValue(product.image, baseUrl));
      result.url = firstValue(result.url, normalizeCanonicalUrl(product.url, baseUrl));

      const offers = offerData(product.offers);
      result.price = firstValue(result.price, offers.price, priceFromValue(product.price));
      result.currency = firstValue(result.currency, offers.currency);

      const aggregateRating = asObject(product.aggregateRating);
      if (aggregateRating) {
        result.rating = firstValue(result.rating, parseRating(aggregateRating.ratingValue));
        result.reviewCount = firstValue(
          result.reviewCount,
          parseReviewCount(aggregateRating.reviewCount),
          parseReviewCount(aggregateRating.ratingCount),
        );
      }
    }
  }

  return result;
}

function titleFromProductUrl(requestedUrl: string): string | null {
  try {
    const url = new URL(requestedUrl);
    if (!url.pathname.toLowerCase().includes('/products/')) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments.at(-1);
    if (!last) return null;

    let slug = decodeURIComponent(last).replace(/\.html?$/i, '');
    slug = slug.replace(/-i\d+(?:-s\d+)?$/i, '');
    slug = collapseWhitespace(slug.replace(/[-_]+/g, ' '));
    if (!slug) return null;
    return slug.charAt(0).toUpperCase() + slug.slice(1);
  } catch {
    return null;
  }
}

function marketplaceCurrencyForUrl(requestedUrl: string): string | null {
  try {
    const url = new URL(requestedUrl);
    return findMarketplace(url.hostname)?.currency ?? null;
  } catch {
    return null;
  }
}

/**
 * Pure, deterministic parser for Lazada pages. Uses embedded module data first,
 * then JSON-LD, then Open Graph / HTML fallbacks.
 */
export function parseLazadaHtml(html: string, requestedUrl: string): ParsedPage {
  const moduleData = asObject(extractModuleData(html));
  const dataRoot = asObject(asObject(moduleData?.data)?.root) ?? asObject(moduleData?.root);
  const fields = asObject(dataRoot?.fields);
  const tracking = asObject(fields?.tracking);
  const product = asObject(fields?.product);
  const trackingCore = asObject(tracking?.core);
  const meta = extractMetaTags(html);
  const jsonLd = extractJsonLd(html, requestedUrl);
  const skuEvidence =
    typeof tracking?.pdt_sku === 'number'
      ? tracking.pdt_sku > 0
      : Boolean(asTrimmedString(tracking?.pdt_sku));
  const hasStructuredProductData =
    Boolean(asTrimmedString(tracking?.pdt_name)) ||
    Boolean(asTrimmedString(tracking?.pdt_price)) ||
    skuEvidence ||
    Boolean(asTrimmedString(tracking?.brand_name)) ||
    Boolean(asTrimmedString(product?.title)) ||
    Boolean(asTrimmedString(product?.name)) ||
    Boolean(asTrimmedString(tracking?.pdt_photo)) ||
    Boolean(jsonLd.name) ||
    jsonLd.price !== null;

  const moduleTitle = firstValue(
    cleanTitle(asTrimmedString(tracking?.pdt_name)),
    cleanTitle(asTrimmedString(product?.title)),
    cleanTitle(asTrimmedString(product?.name)),
    cleanTitle(asTrimmedString(fields?.title)),
  );
  const title = firstValue(
    moduleTitle,
    jsonLd.name,
    cleanTitle(meta.get('og:title') ?? null),
    cleanTitle(meta.get('twitter:title') ?? null),
    extractTitleTag(html),
    // A slug is not product evidence on its own; only use it to fill in a
    // missing name when the page actually contained structured product data.
    // Otherwise an empty/soft-404 response would be silently added as a
    // product with no price.
    hasStructuredProductData ? titleFromProductUrl(requestedUrl) : null,
  );

  const moduleBrand = firstValue(
    cleanBrand(asTrimmedString(tracking?.brand_name)),
    brandFromValue(product?.brand),
    brandFromValue(fields?.brand),
  );
  const brand = firstValue(moduleBrand, jsonLd.brand, cleanBrand(meta.get('og:brand') ?? null));

  const moduleImage = firstValue(
    imageFromValue(tracking?.pdt_photo, requestedUrl),
    imageFromValue(product?.image, requestedUrl),
    imageFromValue(product?.images, requestedUrl),
    imageFromValue(product?.skuGalleries, requestedUrl),
    imageFromValue(fields?.skuGalleries, requestedUrl),
    imageFromValue(fields?.skuInfos, requestedUrl),
    imageFromValue(dataRoot?.skuGalleries, requestedUrl),
  );
  const imageUrl = firstValue(
    moduleImage,
    jsonLd.imageUrl,
    normalizeWebUrl(meta.get('og:image'), requestedUrl),
    normalizeWebUrl(meta.get('twitter:image'), requestedUrl),
  );

  const rawPriceText = firstValue(
    asTrimmedString(tracking?.pdt_price),
    asTrimmedString(tracking?.price),
    asTrimmedString(meta.get('product:price:amount')),
    asTrimmedString(meta.get('og:price:amount')),
  );
  const price = firstValue(
    priceFromValue(tracking?.pdt_price),
    priceFromValue(tracking?.price),
    priceFromValue(product?.price),
    jsonLd.price,
    priceFromValue(meta.get('product:price:amount')),
    priceFromValue(meta.get('og:price:amount')),
  );

  const currency = firstValue(
    parseCurrency(trackingCore?.currencyCode),
    parseCurrency(tracking?.currencyCode),
    parseCurrency(tracking?.currency),
    parseCurrency(fields?.currency),
    jsonLd.currency,
    parseCurrency(meta.get('product:price:currency')),
    parseCurrency(meta.get('og:price:currency')),
    marketplaceCurrencyForUrl(requestedUrl),
  );

  const rating = firstValue(
    jsonLd.rating,
    parseRating(tracking?.pdt_rating),
    parseRating(tracking?.pdt_rating_score),
    parseRating(tracking?.rating),
    parseRating(tracking?.ratingScore),
    parseRating(product?.rating),
  );
  const reviewCount = firstValue(
    jsonLd.reviewCount,
    parseReviewCount(tracking?.pdt_review_count),
    parseReviewCount(tracking?.pdt_reviews),
    parseReviewCount(tracking?.review_count),
    parseReviewCount(tracking?.reviewCount),
    parseReviewCount(product?.review_count),
    parseReviewCount(product?.reviewCount),
  );

  const sku = firstValue(
    asTrimmedString(tracking?.pdt_sku),
    asTrimmedString(product?.sku),
    asTrimmedString(product?.skuId),
  );

  return {
    title,
    brand,
    rating,
    reviewCount,
    currency,
    imageUrl,
    price,
    priceText: rawPriceText,
    canonicalUrl: firstValue(
      jsonLd.url,
      extractCanonicalLink(html),
      normalizeCanonicalUrl(meta.get('og:url'), requestedUrl),
    ),
    sku,
  };
}

const USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function isBlockedFinalUrl(finalUrl: string): boolean {
  const lower = finalUrl.toLowerCase();
  if (lower.includes('_____tmd_____')) return true;
  return /(?:^|[/?&_])punish(?:[/?&=]|$)/i.test(lower);
}

function looksBlocked(html: string): boolean {
  const head = html.slice(0, 20_000).toLowerCase();
  if (head.includes('_____tmd_____')) return true;

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] ?? '').toLowerCase();
  if (/access denied|access forbidden|attention required|just a moment|captcha/.test(title)) {
    return true;
  }

  return (
    html.length < 12_000 &&
    /(captcha|verify (?:that )?you are (?:a )?human|unusual traffic|request (?:was )?blocked|bot detection)/.test(
      head,
    )
  );
}

function networkError(error: unknown, timeoutMs: number): ScrapeError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ScrapeError(
      'NETWORK',
      `Lazada took too long to respond (over ${Math.round(timeoutMs / 1000)}s). Please try again.`,
      { cause: error },
    );
  }
  return new ScrapeError(
    'NETWORK',
    'Could not reach Lazada. Check your connection and try again.',
    { cause: error },
  );
}

function chooseCanonicalUrl(
  candidates: ReadonlyArray<string | null | undefined>,
  requested: NormalizedLazadaUrl,
): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const canonical = canonicalizeLazadaProductUrl(candidate);
    if (canonical) return canonical;
  }
  return requested.url;
}

/**
 * Lazada blocks direct calls to its client-side detail API. When a renderer is
 * configured we render the PDP in headless Chromium and read the displayed
 * sale price + review summary from the Mtop response. This is important because
 * the HTML tracking payload's `pdt_price` is the *original* price on discounted
 * products. HTML is used only as a metadata fallback; when the rendered price
 * is unavailable we deliberately record no price rather than the wrong one.
 */
export class LazadaScraper implements ScraperLike {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly renderer: ProductRenderer | null;
  private requestCount = 0;

  constructor(options: LazadaScraperOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.renderer = options.renderer ?? null;
  }

  async scrape(inputUrl: string): Promise<ScrapeResult> {
    const requested = normalizeLazadaUrl(inputUrl);

    const renderRequest: RenderRequest = {
      url: requested.url,
      locale: requested.marketplace.locale,
      timezoneId: requested.marketplace.timezone,
    };

    let rendered: RenderedProduct | null = null;
    let renderError: unknown = null;
    if (this.renderer) {
      try {
        rendered = await this.renderer.render(renderRequest);
      } catch (error) {
        renderError = error;
      }
    }

    // The live renderer normally gives us the full product. The HTML fetch is
    // only needed when the renderer is unavailable or did not supply a title.
    let pageData: { parsed: ParsedPage; finalUrl: string } | null = null;
    let fallbackError: unknown = null;
    if (!rendered || !rendered.title) {
      try {
        pageData = await this.fetchProductPage(requested);
      } catch (error) {
        fallbackError = error;
      }
    }

    const parsed = pageData?.parsed ?? null;
    const title =
      cleanTitle(rendered?.title ?? null) ?? cleanTitle(parsed?.title ?? null);
    if (!title) {
      if (isScrapeError(fallbackError)) throw fallbackError;
      if (renderError instanceof Error) {
        throw new ScrapeError('PARSE', renderError.message, { cause: renderError });
      }
      throw new ScrapeError(
        'PARSE',
        'Could not read product details from that Lazada page.',
      );
    }

    const candidatePrice = this.renderer
      ? (rendered?.price ?? null)
      : (parsed?.price ?? null);
    const price =
      candidatePrice !== null &&
      Number.isFinite(candidatePrice) &&
      candidatePrice > 0
        ? candidatePrice
        : null;

    const product: ScrapedProduct = {
      url: chooseCanonicalUrl(
        [rendered?.url, pageData?.finalUrl, parsed?.canonicalUrl],
        requested,
      ),
      title,
      brand: cleanBrand(rendered?.brand ?? null) ?? cleanBrand(parsed?.brand ?? null),
      rating: rendered?.rating ?? parsed?.rating ?? null,
      reviewCount: rendered?.reviewCount ?? parsed?.reviewCount ?? null,
      currency:
        parseCurrency(rendered?.currency) ??
        parsed?.currency ??
        requested.marketplace.currency,
      imageUrl: rendered?.imageUrl ?? parsed?.imageUrl ?? null,
      price,
      sku: rendered?.sku ?? parsed?.sku ?? null,
    };

    if (product.price === null) {
      return {
        product,
        warning: this.renderer
          ? DISPLAYED_PRICE_UNAVAILABLE_WARNING
          : "Price unavailable — we'll keep trying.",
      };
    }
    return { product };
  }

  /** Releases the headless browser used for live price extraction. */
  async close(): Promise<void> {
    await this.renderer?.close();
  }

  private async fetchProductPage(
    requested: NormalizedLazadaUrl,
  ): Promise<{ parsed: ParsedPage; finalUrl: string }> {
    const userAgent =
      USER_AGENTS[this.requestCount % USER_AGENTS.length] ?? USER_AGENTS[0] ?? '';
    this.requestCount += 1;

    let response: Response;
    try {
      response = await this.fetchImpl(requested.url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': requested.marketplace.acceptLanguage,
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          referer: requested.marketplace.home,
          'user-agent': userAgent,
          'upgrade-insecure-requests': '1',
        },
      });
    } catch (error) {
      throw networkError(error, this.timeoutMs);
    }

    if (response.status === 404 || response.status === 410) {
      throw new ScrapeError('NOT_FOUND', 'That Lazada product could not be found (404).');
    }
    if (!response.ok) {
      if ([401, 403, 429, 451, 503].includes(response.status)) {
        throw new ScrapeError(
          'BLOCKED',
          `Lazada temporarily blocked this request (HTTP ${response.status}). Please try again in a moment.`,
        );
      }
      throw new ScrapeError(
        'NETWORK',
        `Lazada returned an unexpected response (HTTP ${response.status}).`,
      );
    }

    const contentType = response.headers.get('content-type');
    if (contentType && !/html/i.test(contentType)) {
      throw new ScrapeError('PARSE', 'Lazada did not return an HTML product page.');
    }

    let html: string;
    try {
      html = await response.text();
    } catch (error) {
      throw new ScrapeError('NETWORK', 'Could not read the Lazada response.', { cause: error });
    }

    const finalUrl = response.url || requested.url;
    if (isBlockedFinalUrl(finalUrl) || looksBlocked(html)) {
      throw new ScrapeError(
        'BLOCKED',
        'Lazada blocked this request with an anti-bot check. Please try again in a moment.',
      );
    }

    const parsed = parseLazadaHtml(html, finalUrl);
    if (!parsed.title) {
      throw new ScrapeError('PARSE', 'Could not read product details from that Lazada page.');
    }

    return { parsed, finalUrl };
  }
}
