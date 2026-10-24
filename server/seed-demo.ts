/**
 * Developer utility: `npm run seed:demo`.
 *
 * Refuses to touch a non-empty database unless `--force` is passed. Forced
 * seeding only removes products at the four known demo URLs; other user data
 * is preserved.
 */
import { loadConfig, loadLocalEnv } from './config.js';
import { AppDatabase } from './db.js';
import { toProductDto } from './service.js';

interface DemoDefinition {
  url: string;
  title: string;
  brand: string | null;
  rating: number | null;
  reviewCount: number | null;
  imageUrl: string;
  centerPrice: number;
  finalPrice: number;
  amplitude: number;
}

const DEMO_PRODUCTS: readonly DemoDefinition[] = [
  {
    url: 'https://www.lazada.sg/products/anker-622-magnetic-power-bank-10000mah-i1234567890-s9876543210.html',
    title: 'Anker 622 MagGo Magnetic Battery 10,000mAh',
    brand: 'Anker',
    rating: 4.8,
    reviewCount: 1240,
    imageUrl: '/demo/anker.svg',
    centerPrice: 159,
    finalPrice: 129,
    amplitude: 6,
  },
  {
    url: 'https://www.lazada.sg/products/xiaomi-redmi-buds-6-active-bluetooth-earbuds-i2234567890-s8876543210.html',
    title: 'Xiaomi Redmi Buds 6 Active Bluetooth Earbuds',
    brand: 'Xiaomi',
    rating: 4.3,
    reviewCount: 86,
    imageUrl: '/demo/xiaomi.svg',
    centerPrice: 89,
    finalPrice: 99,
    amplitude: 2,
  },
  {
    url: 'https://www.lazada.sg/products/essential-cotton-crew-neck-t-shirt-i3234567890-s7876543210.html',
    title: 'Essential Cotton Crew Neck T-Shirt',
    brand: null,
    rating: null,
    reviewCount: null,
    imageUrl: '/demo/tshirt.svg',
    centerPrice: 45,
    finalPrice: 45,
    amplitude: 0,
  },
  {
    url: 'https://www.lazada.sg/products/philips-hue-white-and-color-ambiance-smart-bulb-i4234567890-s6876543210.html',
    title: 'Philips Hue White and Colour Ambiance Smart Bulb',
    brand: 'Philips',
    rating: 4.6,
    reviewCount: 312,
    imageUrl: '/demo/philips.svg',
    centerPrice: 26,
    finalPrice: 24.5,
    amplitude: 0.4,
  },
] as const;

const POINT_COUNT = 48;
const SPAN_MS = 5 * 24 * 60 * 60 * 1000;

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function buildPrices(definition: DemoDefinition): number[] {
  const prices: number[] = [];
  for (let index = 0; index < POINT_COUNT - 1; index += 1) {
    const wave =
      Math.sin(index * 0.55) * definition.amplitude +
      Math.sin(index * 0.17) * definition.amplitude * 0.4;
    prices.push(round2(Math.max(1, definition.centerPrice + wave)));
  }
  prices.push(definition.finalPrice);
  return prices;
}

function main(): void {
  const force = process.argv.includes('--force');
  loadLocalEnv();
  const config = loadConfig(process.env);
  const db = new AppDatabase(config.databasePath, {
    trackingIntervalSeconds: config.trackingIntervalSeconds,
  });

  try {
    const existingCount = db.countProducts();
    if (existingCount > 0 && !force) {
      console.error(
        `Refusing to seed: database already contains ${existingCount} product(s). ` +
          'Re-run with --force to replace only the demo products.',
      );
      process.exitCode = 1;
      return;
    }

    if (force) {
      for (const definition of DEMO_PRODUCTS) {
        db.deleteProductByUrl(definition.url);
      }
    }

    const now = Date.now();
    const startedAt = new Date(now - SPAN_MS).toISOString();
    const lastCheckedAt = new Date(now).toISOString();

    for (const definition of DEMO_PRODUCTS) {
      const prices = buildPrices(definition);
      const row = db.createProduct(
        {
          url: definition.url,
          title: definition.title,
          brand: definition.brand,
          rating: definition.rating,
          reviewCount: definition.reviewCount,
          currency: 'SGD',
          imageUrl: definition.imageUrl,
          createdAt: startedAt,
        },
        null,
      );

      prices.forEach((price, index) => {
        const recordedAt = new Date(
          now - SPAN_MS + (index * SPAN_MS) / (prices.length - 1),
        ).toISOString();
        db.addPrice(row.id, price, recordedAt);
      });

      // The final price point and the check share the same timestamp.
      db.recordCheck(row.id, { checkedAt: lastCheckedAt, price: null, error: null });

      const stored = db.getProduct(row.id);
      if (stored) {
        const dto = toProductDto(stored, db.getPriceSummary(row.id, 500));
        console.info(
          `[seed] ${dto.title}: ${prices.length} points, ` +
            `current ${dto.currency} ${dto.currentPrice ?? 'n/a'}, ` +
            `drop ${dto.dropPercent}%`,
        );
      }
    }

    console.info(
      `[seed] Inserted ${DEMO_PRODUCTS.length} demo products into ${config.databasePath}.`,
    );
  } finally {
    db.close();
  }
}

main();
