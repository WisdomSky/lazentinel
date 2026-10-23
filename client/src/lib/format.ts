export function formatPrice(value: number, currency: string): string {
  const zeroDecimalCurrencies = new Set(['IDR', 'VND', 'JPY', 'KRW']);

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: zeroDecimalCurrencies.has(currency) ? 0 : 2,
      maximumFractionDigits: zeroDecimalCurrencies.has(currency) ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function formatCompactPrice(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return String(Math.round(value));
  }
}

export function formatRelativeTime(value: string | null, now: number): string {
  if (!value) return 'Not checked yet';

  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return 'Unknown';

  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function formatDrop(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

export function formatReviewCount(count: number | null): string {
  if (count === null) return '(0)';
  if (count >= 1_000_000) return `(${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}m)`;
  if (count >= 1_000) return `(${(count / 1_000).toFixed(1).replace(/\.0$/, '')}k)`;
  return `(${count})`;
}
