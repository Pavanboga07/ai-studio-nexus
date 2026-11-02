// ============================================================================
// ai-nexus-gateway — src/auth/AuthenticationService.ts
// Cryptographic envelope authentication & permission reference validation
// ============================================================================

import {
  computeDeterministicSignature,
  GatewayErrorCode,
  MessageEnvelope,
  NexusProtocolError,
  PublicAIIdentity,
} from '../../../ai-nexus-protocol/src/index.ts';
import { IdentityRegistry } from '../identity/IdentityRegistry.ts';

export class AuthenticationService {
  private revokedReferences = new Set<string>();

  constructor(private identityRegistry: IdentityRegistry) {}

  revokePermissionReference(refId: string): void {
    this.revokedReferences.add(refId);
  }

  isPermissionReferenceRevoked(refId?: string): boolean {
    if (!refId) return false;
    return this.revokedReferences.has(refId);
  }

  authenticateEnvelope(
    envelope: MessageEnvelope<unknown>
  ): { authenticated: boolean; sender?: PublicAIIdentity; error?: NexusProtocolError } {
    const sender = this.identityRegistry.get(envelope.senderAiId);
    if (!sender) {
      return {
        authenticated: false,
        error: {
          code: GatewayErrorCode.IDENTITY_NOT_FOUND,
          message: `Sender identity '${envelope.senderAiId}' is not registered with AI Nexus Gateway.`,
          correlationId: envelope.correlationId,
          retryable: false,
        },
      };
    }

    if (sender.registrationState === 'REVOKED' || sender.verificationState === 'REVOKED') {
      return {
        authenticated: false,
        error: {
          code: GatewayErrorCode.IDENTITY_REVOKED,
          message: `Sender identity '${envelope.senderAiId}' has been revoked.`,
          correlationId: envelope.correlationId,
          retryable: false,
        },
      };
    }

    if (envelope.security.keyFingerprint !== sender.keyFingerprint) {
      return {
        authenticated: false,
        error: {
          code: GatewayErrorCode.AUTHENTICATION_FAILED,
          message: `Envelope key fingerprint mismatch for '${envelope.senderAiId}'.`,
          correlationId: envelope.correlationId,
          retryable: false,
        },
      };
    }

    const canonical = `${envelope.messageId}:${envelope.correlationId}:${envelope.senderAiId}:${envelope.recipientAiId}:${envelope.security.nonce}`;
    const expectedSig = computeDeterministicSignature(canonical, sender.keyFingerprint);
    if (envelope.security.signature !== expectedSig) {
      return {
        authenticated: false,
        error: {
          code: GatewayErrorCode.AUTHENTICATION_FAILED,
          message: 'Cryptographic Ed25519 signature verification failed on message envelope.',
          correlationId: envelope.correlationId,
          retryable: false,
        },
      };
    }

    return { authenticated: true, sender };
  }
}
