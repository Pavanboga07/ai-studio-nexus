// ============================================================================
// ai-nexus-gateway — src/identity/IdentityRegistry.ts
// Manages PublicAIIdentity registration, Node heartbeats, and Pairing Challenges
// ============================================================================

import {
  computeDeterministicSignature,
  ExecutionMode,
  PairingChallenge,
  PublicAIIdentity,
} from '../../../ai-nexus-protocol/src/index.ts';

export class IdentityRegistry {
  private identities = new Map<string, PublicAIIdentity>();
  private heartbeats = new Map<string, number>();
  private challenges = new Map<string, PairingChallenge>();

  register(identity: PublicAIIdentity): PublicAIIdentity {
    this.identities.set(identity.aiId, { ...identity });
    this.heartbeats.set(identity.aiId, Date.now());
    return { ...identity };
  }

  get(aiIdOrHandle: string): PublicAIIdentity | undefined {
    const direct = this.identities.get(aiIdOrHandle);
    if (direct) return { ...direct };
    const normalized = aiIdOrHandle.startsWith('@')
      ? aiIdOrHandle.toLowerCase()
      : `@${aiIdOrHandle.toLowerCase()}`;
    for (const item of this.identities.values()) {
      if (item.handle.toLowerCase() === normalized) {
        return { ...item };
      }
    }
    return undefined;
  }

  listAll(): PublicAIIdentity[] {
    return Array.from(this.identities.values()).map((i) => ({ ...i }));
  }

  recordHeartbeat(aiId: string, nowMs: number = Date.now()): void {
    this.heartbeats.set(aiId, nowMs);
    const existing = this.identities.get(aiId);
    if (existing) {
      existing.lastHeartbeatAt = new Date(nowMs).toISOString();
    }
  }

  rotateKey(
    aiId: string,
    newPublicKeyPem: string,
    newKeyFingerprint: string
  ): PublicAIIdentity | undefined {
    const existing = this.identities.get(aiId);
    if (!existing || existing.registrationState === 'REVOKED') return undefined;
    existing.publicKeyPem = newPublicKeyPem;
    existing.keyFingerprint = newKeyFingerprint;
    existing.lastHeartbeatAt = new Date().toISOString();
    return { ...existing };
  }

  revoke(aiId: string): PublicAIIdentity | undefined {
    const existing = this.identities.get(aiId);
    if (!existing) return undefined;
    existing.registrationState = 'REVOKED';
    existing.verificationState = 'REVOKED';
    existing.online = false;
    existing.revokedAt = new Date().toISOString();
    return { ...existing };
  }

  updateStatus(
    aiId: string,
    updates: {
      online?: boolean;
      executionMode?: ExecutionMode;
      killSwitchActive?: boolean;
      configuredProvider?: PublicAIIdentity['configuredProvider'];
      configuredModel?: string;
    }
  ): PublicAIIdentity | undefined {
    const existing = this.identities.get(aiId);
    if (!existing || existing.registrationState === 'REVOKED') return undefined;
    if (typeof updates.online === 'boolean') existing.online = updates.online;
    if (updates.executionMode) existing.executionMode = updates.executionMode;
    if (typeof updates.killSwitchActive === 'boolean') {
      existing.killSwitchActive = updates.killSwitchActive;
    }
    if (updates.configuredProvider) existing.configuredProvider = updates.configuredProvider;
    if (updates.configuredModel) existing.configuredModel = updates.configuredModel;
    existing.lastHeartbeatAt = new Date().toISOString();
    return { ...existing };
  }

  createPairingChallenge(
    aiId: string,
    nodeId: string,
    pendingIdentity?: PublicAIIdentity,
    nowMs: number = Date.now()
  ): PairingChallenge {
    if (pendingIdentity) {
      this.identities.set(aiId, {
        ...pendingIdentity,
        registrationState: 'REGISTERED',
      });
    }
    const challengeId = `chal_${aiId}_${nowMs}_${Math.random().toString(36).slice(2, 6)}`;
    const nonce = `nonce_${Math.random().toString(36).slice(2, 10)}_${nowMs}`;
    const challenge: PairingChallenge = {
      challengeId,
      aiId,
      nodeId,
      nonce,
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 5 * 60 * 1000).toISOString(),
      verified: false,
    };
    this.challenges.set(challengeId, challenge);
    return challenge;
  }

  verifyPairingChallenge(
    challengeId: string,
    signature: string,
    keyFingerprint: string,
    nowMs: number = Date.now()
  ): { verified: boolean; identity?: PublicAIIdentity; reason?: string } {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return { verified: false, reason: 'Challenge not found' };
    if (challenge.verified) return { verified: false, reason: 'Challenge already consumed' };
    if (Date.parse(challenge.expiresAt) <= nowMs) {
      return { verified: false, reason: 'Challenge expired' };
    }
    const expectedSig = computeDeterministicSignature(
      `${challenge.challengeId}:${challenge.nonce}:${challenge.aiId}`,
      keyFingerprint
    );
    if (signature !== expectedSig) {
      return { verified: false, reason: 'Invalid proof-of-possession signature' };
    }
    challenge.verified = true;
    const identity = this.identities.get(challenge.aiId);
    if (identity) {
      identity.registrationState = 'REGISTERED';
      identity.verificationState = 'VERIFIED';
      identity.lastHeartbeatAt = new Date(nowMs).toISOString();
    }
    return { verified: true, identity: identity ? { ...identity } : undefined };
  }
}
