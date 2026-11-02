import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDeterministicSignature,
  createSignedMessageEnvelope,
  EnvelopeMessageType,
  ExecutionMode,
  GatewayErrorCode,
  PublicAIIdentity,
} from '../../ai-nexus-protocol/src/index.ts';
import { createGatewayServer } from '../src/server/gatewayMain.ts';

test('Gateway starts independently on its own port and responds to /health and /ready without Chatbot', async () => {
  const gw = await createGatewayServer({ port: 0 });
  try {
    const healthRes = await fetch(`http://127.0.0.1:${gw.port}/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.service, 'ai-nexus-gateway');
    assert.equal(health.status, 'OK');
    assert.equal(health.wsPath, '/ws/node');

    const readyRes = await fetch(`http://127.0.0.1:${gw.port}/ready`);
    assert.equal(readyRes.status, 200);
    const ready = await readyRes.json();
    assert.equal(ready.ready, true);
  } finally {
    await gw.close();
  }
});

test('Gateway enforces Ed25519 challenge-response pairing and replay protection', async () => {
  const gw = await createGatewayServer({ port: 0 });
  try {
    const aliceIdentity: PublicAIIdentity = {
      aiId: 'ai_alice',
      handle: '@alice',
      displayName: 'Alice AI',
      ownerId: 'owner_alice',
      ownerDisplayName: 'Alice Vance',
      nodeId: 'node_alice_01',
      deviceId: 'dev_alice_01',
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAliceKey\n-----END PUBLIC KEY-----',
      keyFingerprint: 'ed25519:a11ce98f4d20b7e1c9034f82',
      registrationState: 'PENDING_CHALLENGE',
      verificationState: 'UNVERIFIED',
      executionMode: ExecutionMode.LOCAL,
      online: true,
      killSwitchActive: false,
      supportedProtocolVersions: ['1.0'],
      configuredProvider: 'gemini',
      configuredModel: 'gemini-3.8-flash',
      createdAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    };

    const chalRes = await fetch(`http://127.0.0.1:${gw.port}/api/v1/pairing/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aiId: aliceIdentity.aiId,
        nodeId: aliceIdentity.nodeId,
        identity: aliceIdentity,
      }),
    });
    const { challenge } = await chalRes.json();
    const validSig = computeDeterministicSignature(
      `${challenge.challengeId}:${challenge.nonce}:${challenge.aiId}`,
      aliceIdentity.keyFingerprint
    );

    const verRes = await fetch(`http://127.0.0.1:${gw.port}/api/v1/pairing/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        aiId: aliceIdentity.aiId,
        keyFingerprint: aliceIdentity.keyFingerprint,
        signature: validSig,
      }),
    });
    const verData = await verRes.json();
    assert.equal(verData.verified, true);

    // Replay of same challenge must fail
    const replayRes = await fetch(`http://127.0.0.1:${gw.port}/api/v1/pairing/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        aiId: aliceIdentity.aiId,
        keyFingerprint: aliceIdentity.keyFingerprint,
        signature: validSig,
      }),
    });
    const replayData = await replayRes.json();
    assert.equal(replayData.verified, false);
  } finally {
    await gw.close();
  }
});
