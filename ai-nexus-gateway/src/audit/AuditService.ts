// ============================================================================
// ai-nexus-gateway — src/audit/AuditService.ts
// Gateway Operational & Security Audit Logger
// ============================================================================

import { AuditEventRecord } from '../../../ai-nexus-protocol/src/index.ts';

export class GatewayAuditService {
  private events: AuditEventRecord[] = [];

  record(event: Omit<AuditEventRecord, 'eventId' | 'timestamp'>): AuditEventRecord {
    const full: AuditEventRecord = {
      ...event,
      eventId: `aud_gw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
    };
    this.events.unshift(full);
    if (this.events.length > 300) {
      this.events.length = 300;
    }
    return full;
  }

  list(): AuditEventRecord[] {
    return [...this.events];
  }
}
