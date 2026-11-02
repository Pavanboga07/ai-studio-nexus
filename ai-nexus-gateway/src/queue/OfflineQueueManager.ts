// ============================================================================
// ai-nexus-gateway — src/queue/OfflineQueueManager.ts
// Queues eligible invocations when recipient Personal AI node is offline
// ============================================================================

import {
  InvocationRecord,
  InvocationState,
} from '../../../ai-nexus-protocol/src/index.ts';

export class OfflineQueueManager {
  private queues = new Map<string, InvocationRecord[]>();

  enqueue(recipientAiId: string, record: InvocationRecord): void {
    const list = this.queues.get(recipientAiId) ?? [];
    if (!list.some((item) => item.idempotencyKey === record.idempotencyKey)) {
      list.push(record);
      this.queues.set(recipientAiId, list);
    }
  }

  drainEligible(recipientAiId: string, nowMs: number = Date.now()): {
    validRecords: InvocationRecord[];
    expiredRecords: InvocationRecord[];
  } {
    const list = this.queues.get(recipientAiId) ?? [];
    this.queues.delete(recipientAiId);
    const validRecords: InvocationRecord[] = [];
    const expiredRecords: InvocationRecord[] = [];

    for (const rec of list) {
      if (Date.parse(rec.expiresAt) <= nowMs) {
        rec.state = InvocationState.EXPIRED;
        rec.queuedOffline = false;
        rec.transitions.push({
          state: InvocationState.EXPIRED,
          timestamp: new Date(nowMs).toISOString(),
          summary: 'Queued request expired while recipient node was offline.',
          actor: 'GATEWAY',
        });
        expiredRecords.push(rec);
      } else {
        validRecords.push(rec);
      }
    }
    return { validRecords, expiredRecords };
  }

  getQueuedFor(recipientAiId: string): InvocationRecord[] {
    return [...(this.queues.get(recipientAiId) ?? [])];
  }

  getAllQueued(): InvocationRecord[] {
    const all: InvocationRecord[] = [];
    for (const list of this.queues.values()) {
      all.push(...list);
    }
    return all;
  }
}
