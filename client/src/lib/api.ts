import type {
  AuthResponse,
  AuthSessionResponse,
  ProductResponse,
  ProductsResponse,
  Settings,
} from '@/lib/types';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Something went wrong. Please try again.';
}

function fallbackMessage(status: number): string {
  if (status === 404) return 'That item could not be found.';
  if (status === 409) return 'This product is already being tracked.';
  if (status === 422) return 'The product page could not be read.';
  return `Request failed with status ${status}.`;
}

async function parseErrorMessage(response: Response): Promise<string> {
  const fallback = fallbackMessage(response.status);
  try {
    const text = await response.text();
    if (!text) return fallback;

    const payload: unknown = JSON.parse(text);
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof (payload as { error?: unknown }).error === 'string'
    ) {
      const message = (payload as { error: string }).error.trim();
      if (message) return message;
    }
  } catch {
    // Non-JSON error bodies fall back to a status-based message.
  }
  return fallback;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event('lazentinel:unauthorized'));
    }
    throw new ApiError(await parseErrorMessage(response), response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function getProducts(signal?: AbortSignal): Promise<ProductsResponse> {
  return request<ProductsResponse>('/api/products', { signal });
}

export async function createProduct(url: string): Promise<ProductResponse> {
  return request<ProductResponse>('/api/products', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

export async function deleteProduct(id: number): Promise<void> {
  return request<void>(`/api/products/${id}`, { method: 'DELETE' });
}

export async function refreshProduct(id: number): Promise<ProductResponse> {
  return request<ProductResponse>(`/api/products/${id}/refresh`, {
    method: 'POST',
  });
}

export async function getSettings(signal?: AbortSignal): Promise<Settings> {
  return request<Settings>('/api/settings', { signal });
}

export async function getAuthSession(
  signal?: AbortSignal,
): Promise<AuthSessionResponse> {
  return request<AuthSessionResponse>('/api/auth/session', { signal });
}

export async function login(
  email: string,
  password: string,
): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function register(
  email: string,
  password: string,
  confirmPassword: string,
): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, confirmPassword }),
  });
}

export async function logout(): Promise<void> {
  return request<void>('/api/auth/logout', { method: 'POST' });
}
