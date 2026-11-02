// ============================================================================
// ai-nexus-gateway — src/security/SecurityGuards.ts
// RateLimiter, ReplayProtection, IdempotencyService & Origin Validation
// ============================================================================

import { InvocationRecord } from '../../../ai-nexus-protocol/src/index.ts';

export class RateLimiter {
  private counters = new Map<string, { count: number; windowStartMs: number }>();
  constructor(private maxPerMinute: number = 60) {}

  checkAndIncrement(aiId: string, nowMs: number = Date.now()): boolean {
    const entry = this.counters.get(aiId);
    if (!entry || nowMs - entry.windowStartMs >= 60_000) {
      this.counters.set(aiId, { count: 1, windowStartMs: nowMs });
      return true;
    }
    if (entry.count >= this.maxPerMinute) {
      return false;
    }
    entry.count += 1;
    return true;
  }
}

export class ReplayAndIdempotencyGuard {
  private seenNonces = new Set<string>();
  private idempotencyResults = new Map<string, InvocationRecord>();

  checkAndRecordNonce(senderAiId: string, nonce: string): boolean {
    const key = `${senderAiId}:${nonce}`;
    if (this.seenNonces.has(key)) return false;
    this.seenNonces.add(key);
    return true;
  }

  getIdempotentRecord(idempotencyKey: string): InvocationRecord | undefined {
    return this.idempotencyResults.get(idempotencyKey);
  }

  saveIdempotentRecord(idempotencyKey: string, record: InvocationRecord): void {
    this.idempotencyResults.set(idempotencyKey, record);
  }
}

export function isOriginAllowed(origin: string | undefined, allowedOriginsCsv: string): boolean {
  if (!origin) return true; // Node-to-Node backend/CLI WebSocket connections may omit browser Origin header
  const allowedList = allowedOriginsCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedList.includes('*') || allowedList.includes(origin)) {
    return true;
  }
  return false;
}
