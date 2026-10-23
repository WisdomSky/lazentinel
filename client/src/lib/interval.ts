export const MIN_TRACKING_INTERVAL_SECONDS = 5;
export const MAX_TRACKING_INTERVAL_SECONDS = 86_400;

export function isValidTrackingInterval(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_TRACKING_INTERVAL_SECONDS &&
    value <= MAX_TRACKING_INTERVAL_SECONDS
  );
}

export function formatInterval(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';

  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }

  if (seconds > 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }

  if (seconds > 60) {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}
