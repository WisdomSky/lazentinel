export interface PricePoint {
  price: number;
  recordedAt: string;
}

export interface Product {
  id: number;
  url: string;
  title: string;
  brand: string | null;
  rating: number | null;
  reviewCount: number | null;
  currency: string;
  imageUrl: string | null;
  createdAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  currentPrice: number | null;
  previousPrice: number | null;
  priceChange: number | null;
  dropPercent: number;
  lowestPrice: number | null;
  highestPrice: number | null;
  history: PricePoint[];
}

export interface Settings {
  trackingIntervalSeconds: number;
}

export interface ProductsResponse {
  products: Product[];
}

export interface ProductResponse {
  product: Product;
  warning?: string;
}

export interface ApiError {
  error: string;
}
