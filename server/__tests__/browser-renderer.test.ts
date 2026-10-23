import { describe, expect, it, vi } from 'vitest';
import {
  LazadaBrowserRenderer,
  RenderBlockedError,
  extractMtopProductData,
} from '../browser-renderer.js';
import type { ProxyProvider } from '../proxy/proxy_resolver.js';

/**
 * Realistic Mtop PDP module. `tracking.pdt_price` is the struck-through
 * original price; the actual displayed price lives in the SKU salePrice.
 */
function makeMtopModule(): Record<string, unknown> {
  return {
    tracking: {
      pdt_name: 'Acme Wireless Earbuds',
      brand_name: 'Tracking Brand',
      pdt_price: 13_990,
      core: { currencyCode: 'PHP' },
    },
    product: {
      title: 'Product Field Title',
      brand: { name: 'Acme' },
      link: 'https://www.lazada.com.ph/products/acme-earbuds-i123.html',
      image: '//img.lazada.com/product.jpg',
    },
    primaryKey: { defaultSkuId: 'sku-red' },
    skuInfos: {
      'sku-red': {
        price: {
          salePrice: { value: 3_000, text: '₱3,000.00' },
          originalPrice: { value: 13_990, text: '₱13,990.00' },
        },
        image: 'https://img.lazada.com/p/earbuds-red.jpg',
      },
      'sku-blue': {
        price: {
          salePrice: { value: 2_500 },
          originalPrice: { value: 13_990 },
        },
        image: 'https://img.lazada.com/p/earbuds-blue.jpg',
      },
    },
    review: { averageRating: 5, reviews: 62 },
    globalConfig: { currency: 'PHP' },
  };
}

describe('extractMtopProductData', () => {
  it('extracts the displayed sale price, never the original pdt_price', () => {
    const data = extractMtopProductData(makeMtopModule());

    expect(data).not.toBeNull();
    expect(data).toMatchObject({
      url: 'https://www.lazada.com.ph/products/acme-earbuds-i123.html',
      title: 'Acme Wireless Earbuds',
      brand: 'Acme',
      rating: 5,
      reviewCount: 62,
      price: 3_000,
      currency: 'PHP',
      imageUrl: 'https://img.lazada.com/p/earbuds-red.jpg',
      sku: 'sku-red',
    });
    // The HTML/module original price must never win.
    expect(data?.price).not.toBe(13_990);
  });

  it('reads the review summary rating and review count', () => {
    const data = extractMtopProductData({
      tracking: { pdt_name: 'Reviewed Product' },
      review: { averageRating: 5, reviews: 62 },
    });

    expect(data?.rating).toBe(5);
    expect(data?.reviewCount).toBe(62);
  });

  it.each([
    ['1.234', 1_234],
    ['1,234', 1_234],
    ['1 234', 1_234],
    ['1.2k', 1_200],
    ['2,5k', 2_500],
    ['1.234k', 1_234_000],
  ])('parses review count %j as %d', (reviews, expected) => {
    const data = extractMtopProductData({
      tracking: { pdt_name: 'Formatted Review Count' },
      review: { reviews },
    });

    expect(data?.reviewCount).toBe(expected);
  });

  it('prefers the SKU referenced by primaryKey.defaultSkuId', () => {
    const module = {
      ...makeMtopModule(),
      primaryKey: { defaultSkuId: 'sku-blue' },
    };
    const data = extractMtopProductData(module);

    expect(data?.price).toBe(2_500);
    expect(data?.sku).toBe('sku-blue');
    expect(data?.imageUrl).toBe('https://img.lazada.com/p/earbuds-blue.jpg');
  });

  it.each([222, '222'])('accepts %j defaultSkuId and selects its SKU', (defaultSkuId) => {
    const data = extractMtopProductData({
      tracking: { pdt_name: 'Multi SKU Product' },
      primaryKey: { defaultSkuId },
      skuInfos: {
        '111': { price: { salePrice: { value: 1_000 } } },
        '222': { price: { salePrice: { value: 2_000 } } },
      },
    });

    expect(data?.price).toBe(2_000);
    expect(data?.sku).toBe('222');
  });

  it('falls back to the first SKU when no default SKU is available', () => {
    const data = extractMtopProductData({
      tracking: { pdt_name: 'Multi SKU Product' },
      skuInfos: {
        first: { price: { salePrice: { value: 1_111 } } },
        second: { price: { salePrice: { value: 2_222 } } },
      },
    });

    expect(data?.price).toBe(1_111);
    expect(data?.sku).toBe('first');
  });

  it('falls back to the salePrice text when value is absent', () => {
    const data = extractMtopProductData({
      tracking: { pdt_name: 'Text Priced Product' },
      primaryKey: { defaultSkuId: 'sku-text' },
      skuInfos: {
        'sku-text': {
          price: {
            salePrice: { text: '₱3,000.00' },
            originalPrice: { value: 13_990 },
          },
        },
      },
    });

    expect(data?.price).toBe(3_000);
  });

  it('returns a null price when only originalPrice exists', () => {
    const data = extractMtopProductData({
      tracking: { pdt_name: 'Original Only Product' },
      primaryKey: { defaultSkuId: 'sku-original' },
      skuInfos: {
        'sku-original': {
          price: {
            originalPrice: { value: 13_990 },
          },
        },
      },
    });

    expect(data).not.toBeNull();
    expect(data?.price).toBeNull();
  });

  it.each([
    null,
    undefined,
    42,
    'not-an-object',
    [],
    {},
    { tracking: {} },
    { product: {} },
  ])('returns null for non-object or empty module data %j', (value) => {
    expect(extractMtopProductData(value)).toBeNull();
  });
});

describe('LazadaBrowserRenderer proxy cooldown', () => {
  it('pauses a URL for three hours after every proxy fails', async () => {
    const nextProxy = vi.fn(async () => {
      throw new Error('no proxy is available');
    });
    const proxyResolver: ProxyProvider = {
      size: 19,
      nextProxy,
      reportFailure: () => undefined,
    };
    const renderer = new LazadaBrowserRenderer({
      logger: { error: () => undefined, info: () => undefined },
      proxyResolver,
    });
    const request = {
      url: 'https://www.lazada.sg/products/proxied-i1.html',
      locale: 'en-SG',
      timezoneId: 'Asia/Singapore',
    };

    await expect(renderer.render(request)).rejects.toBeInstanceOf(RenderBlockedError);
    const second = renderer.render(request);
    await expect(second).rejects.toBeInstanceOf(RenderBlockedError);
    await expect(second).rejects.toThrow(/Pausing checks for 3 hours/);

    // The second call is rejected from the cooldown, without touching proxies.
    expect(nextProxy).toHaveBeenCalledTimes(1);
    await renderer.close();
  });
});
