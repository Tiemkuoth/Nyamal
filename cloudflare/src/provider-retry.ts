const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_INLINE_RETRY_DELAY_MS = 5000;

export function transientProviderRetryDelay(status: number, retryAfter: string | null): number | undefined {
  if (!RETRYABLE_STATUSES.has(status)) return undefined;
  if (retryAfter === null || !retryAfter.trim()) return DEFAULT_RETRY_DELAY_MS;

  const seconds = Number(retryAfter);
  const requestedDelay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(retryAfter) - Date.now();
  if (!Number.isFinite(requestedDelay) || requestedDelay < 0
    || requestedDelay > MAX_INLINE_RETRY_DELAY_MS) return undefined;
  return Math.max(250, requestedDelay);
}

export function shouldTryNextProviderModel(status: number | undefined): boolean {
  return status === undefined || status === 404 || RETRYABLE_STATUSES.has(status);
}
