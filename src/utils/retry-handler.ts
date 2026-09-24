import { logger } from '../logger.ts';
import { DownloadTask, ErrorCategory } from '../types.ts';

export interface RetryDecision {
  shouldRetry: boolean;
  action: 'rediscover' | 'backoff' | 'refresh_auth' | 'wait_flood' | 'retry_immediate' | 'abort';
  delayMs: number;
  reason: string;
}

export interface RetryPolicyOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxFloodWaitSeconds?: number;
}

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_BACKOFF_MS = 1500;
export const DEFAULT_MAX_BACKOFF_MS = 30000;
export const DEFAULT_MAX_FLOOD_WAIT_SECONDS = 180;

/**
 * Calculates exponential backoff with full jitter to avoid thundering herd.
 * Formula: uniform_random(0, min(maxBackoffMs, baseBackoffMs * 2^(attempt - 1)))
 */
export function calculateBackoffWithJitter(
  attempt: number,
  baseBackoffMs: number = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs: number = DEFAULT_MAX_BACKOFF_MS
): number {
  const expFactor = Math.pow(2, Math.max(0, attempt - 1));
  const rawBackoff = Math.min(maxBackoffMs, baseBackoffMs * expFactor);
  // Full jitter: random between 50% and 100% of rawBackoff
  const minJitter = rawBackoff * 0.5;
  const jitterRange = rawBackoff * 0.5;
  return Math.floor(minJitter + Math.random() * jitterRange);
}

/**
 * Parses flood wait seconds from Telegram error messages or objects
 */
export function parseFloodWaitSeconds(err: any): number | null {
  if (!err) return null;

  // 1. GramJS FloodWaitError property
  if (typeof err.seconds === 'number' && err.seconds > 0) {
    return err.seconds;
  }

  const errStr = err?.message || String(err);

  // 2. Pattern FLOOD_WAIT_X
  const match1 = errStr.match(/FLOOD_WAIT_(\d+)/i);
  if (match1) {
    return parseInt(match1[1], 10);
  }

  // 3. Pattern "A wait of X seconds is required"
  const match2 = errStr.match(/wait of (\d+)\s*(?:seconds|s)/i);
  if (match2) {
    return parseInt(match2[1], 10);
  }

  // 4. Pattern "flood wait: X"
  const match3 = errStr.match(/flood(?:\s+wait)?[:\s]+(\d+)/i);
  if (match3) {
    return parseInt(match3[1], 10);
  }

  return null;
}

/**
 * Classifies HTTP status code from error message or response
 */
export function extractHttpStatus(err: any): number | null {
  if (!err) return null;
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (typeof err.status === 'number') return err.status;

  const errStr = err?.message || String(err);
  const match = errStr.match(/\b(401|403|429|500|502|503|504)\b/);
  if (match) {
    return parseInt(match[1], 10);
  }

  if (errStr.includes('403 Forbidden') || errStr.includes('Forbidden')) return 403;
  if (errStr.includes('401 Unauthorized') || errStr.includes('Unauthorized')) return 401;
  if (errStr.includes('429 Too Many Requests') || errStr.includes('rate limit')) return 429;
  if (errStr.includes('502 Bad Gateway')) return 502;
  if (errStr.includes('503 Service Unavailable')) return 503;
  if (errStr.includes('504 Gateway Timeout')) return 504;
  if (errStr.includes('500 Internal Server Error')) return 500;

  return null;
}

/**
 * Evaluates whether an error should trigger a retry, and specifies the exact action:
 * - 403 -> refresh session/header -> rediscover -> retry
 * - 401 -> refresh authentication context -> rediscover -> retry
 * - 429 -> backoff -> retry
 * - 5xx -> exponential backoff -> retry
 * - timeout -> retry
 * - expired manifest -> rediscover -> retry
 *
 * Enforces MAX_RETRIES.
 */
export function evaluateRetryPolicy(
  err: any,
  attempt: number,
  options?: RetryPolicyOptions
): RetryDecision {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseBackoffMs = options?.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = options?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const maxFloodWait = options?.maxFloodWaitSeconds ?? DEFAULT_MAX_FLOOD_WAIT_SECONDS;

  const errStr = (err?.message || String(err)).toLowerCase();

  // 1. Strict DRM / Unsupported Encryption / Fatal Permissions: NEVER RETRY
  if (
    errStr.includes('drm') ||
    errStr.includes('widevine') ||
    errStr.includes('fairplay') ||
    errStr.includes('playready') ||
    errStr.includes('clearkey') ||
    errStr.includes('sample-aes') ||
    errStr.includes('chat_admin_required') ||
    errStr.includes('chat_write_forbidden') ||
    errStr.includes('channel_private') ||
    errStr.includes('user_banned_in_channel')
  ) {
    return {
      shouldRetry: false,
      action: 'abort',
      delayMs: 0,
      reason: `Fatal non-retryable error: ${errStr.slice(0, 100)}`,
    };
  }

  // 2. Check for Telegram FloodWait
  const floodSeconds = parseFloodWaitSeconds(err);
  if (floodSeconds !== null) {
    if (floodSeconds <= maxFloodWait) {
      // Must wait the exact duration instructed by Telegram + 1s safety jitter
      const delayMs = (floodSeconds + 1) * 1000;
      return {
        shouldRetry: true,
        action: 'wait_flood',
        delayMs,
        reason: `Telegram FloodWait of ${floodSeconds}s required. Waiting without spamming retry.`,
      };
    } else {
      return {
        shouldRetry: false,
        action: 'abort',
        delayMs: 0,
        reason: `Telegram FloodWait duration (${floodSeconds}s) exceeds maximum allowed tolerance (${maxFloodWait}s).`,
      };
    }
  }

  // 3. Enforce MAX_RETRIES boundary
  if (attempt >= maxRetries) {
    return {
      shouldRetry: false,
      action: 'abort',
      delayMs: 0,
      reason: `Exceeded maximum retry limit (${maxRetries} attempts). Last error: ${errStr.slice(0, 80)}`,
    };
  }

  const httpStatus = extractHttpStatus(err);

  // 4. HTTP 403 Forbidden: Refresh session/header -> rediscover -> retry
  if (httpStatus === 403 || errStr.includes('403 forbidden') || errStr.includes('access denied')) {
    const delayMs = calculateBackoffWithJitter(attempt, baseBackoffMs, maxBackoffMs);
    return {
      shouldRetry: true,
      action: 'rediscover',
      delayMs,
      reason: `HTTP 403 Forbidden: Refreshing session headers, clearing stale manifest, and rediscovering source page.`,
    };
  }

  // 5. HTTP 401 Unauthorized: Refresh authentication context -> rediscover -> retry
  if (httpStatus === 401 || errStr.includes('401 unauthorized')) {
    const delayMs = calculateBackoffWithJitter(attempt, baseBackoffMs, maxBackoffMs);
    return {
      shouldRetry: true,
      action: 'refresh_auth',
      delayMs,
      reason: `HTTP 401 Unauthorized: Refreshing auth context, regenerating tokens, and rediscovering stream.`,
    };
  }

  // 6. HTTP 429 Too Many Requests (Rate limit): Backoff -> retry
  if (httpStatus === 429 || errStr.includes('429') || errStr.includes('rate limit') || errStr.includes('too many requests')) {
    // Add extra backoff for 429
    const delayMs = calculateBackoffWithJitter(attempt, baseBackoffMs * 2, maxBackoffMs);
    return {
      shouldRetry: true,
      action: 'backoff',
      delayMs,
      reason: `HTTP 429 Rate Limit: Applying backoff with jitter (${delayMs}ms) before retry.`,
    };
  }

  // 7. HTTP 5xx Server Errors (500, 502, 503, 504): Exponential backoff -> retry
  if ((httpStatus && httpStatus >= 500 && httpStatus <= 599) || errStr.includes('bad gateway') || errStr.includes('service unavailable')) {
    const delayMs = calculateBackoffWithJitter(attempt, baseBackoffMs, maxBackoffMs);
    return {
      shouldRetry: true,
      action: 'backoff',
      delayMs,
      reason: `HTTP ${httpStatus || '5xx'} Server Error: Applying exponential backoff with jitter (${delayMs}ms).`,
    };
  }

  // 8. Expired Manifest / Expired Signed URL: Rediscover -> retry
  if (
    errStr.includes('expired') ||
    errStr.includes('token or session has expired') ||
    errStr.includes('signed url expired') ||
    errStr.includes('wstime') ||
    errStr.includes('signature')
  ) {
    const delayMs = Math.min(1000, baseBackoffMs);
    return {
      shouldRetry: true,
      action: 'rediscover',
      delayMs,
      reason: `Expired manifest / signed URL: Rediscovering fresh manifest from source page.`,
    };
  }

  // 9. Timeout: Retry
  if (
    errStr.includes('timeout') ||
    errStr.includes('timed out') ||
    errStr.includes('etimedout') ||
    errStr.includes('aborterror')
  ) {
    const delayMs = calculateBackoffWithJitter(attempt, baseBackoffMs, maxBackoffMs);
    return {
      shouldRetry: true,
      action: 'retry_immediate',
      delayMs,
      reason: `Connection/Operation Timeout: Retrying after backoff (${delayMs}ms).`,
    };
  }

  // 10. Network errors / Connection reset: Retry with backoff
  if (
    errStr.includes('econnreset') ||
    errStr.includes('econnrefused') ||
    errStr.includes('socket hang up') ||
    errStr.includes('connection reset') ||
    errStr.includes('fetch failed') ||
    errStr.includes('temporary telegram error') ||
    errStr.includes('rpc_call_fail') ||
    errStr.includes('msg_wait_failed')
  ) {
    const delayMs = calculateBackoffWithJitter(attempt, baseBackoffMs, maxBackoffMs);
    return {
      shouldRetry: true,
      action: 'backoff',
      delayMs,
      reason: `Network/Socket error (${errStr.slice(0, 40)}): Retrying with backoff (${delayMs}ms).`,
    };
  }

  // Default: general retry with backoff if attempts remain
  const defaultDelay = calculateBackoffWithJitter(attempt, baseBackoffMs, maxBackoffMs);
  return {
    shouldRetry: true,
    action: 'backoff',
    delayMs: defaultDelay,
    reason: `Temporary failure: Retrying attempt ${attempt + 1}/${maxRetries} after ${defaultDelay}ms.`,
  };
}

/**
 * Executes a task-level action with automatic refresh, rediscovery, or backoff
 */
export async function executeTaskRetryAction(
  task: DownloadTask,
  decision: RetryDecision
): Promise<void> {
  logger.info(`[RetryPolicy] Executing retry action '${decision.action}' for task ${task.id}: ${decision.reason}`);

  if (decision.delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, decision.delayMs));
  }

  switch (decision.action) {
    case 'rediscover':
    case 'refresh_auth':
      // Clear stale manifests, stream URLs, and cached headers
      task.streamUrl = undefined;
      task.discoveredMedia = [];
      task.discoveredAt = undefined;
      task.encryption = undefined;
      task.rediscoveryCount = (task.rediscoveryCount || 0) + 1;
      // Invalidate cookies or force fresh session header if present
      if (decision.action === 'refresh_auth') {
        task.cookies = undefined;
        task.streamHeaders = undefined;
      }
      break;

    case 'backoff':
    case 'wait_flood':
    case 'retry_immediate':
    default:
      // Wait completed, proceed to retry
      break;
  }
}
