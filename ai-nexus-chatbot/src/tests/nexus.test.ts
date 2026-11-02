// ============================================================================
// AI NEXUS — End-to-End Cross-Process Integration & Verification Suite
// Verifies strict separation between:
//   - Application A: ai-nexus-chatbot (src/server/chatbotMain.ts)
//   - Application B: ai-nexus-gateway (ai-nexus-gateway/src/server/gatewayMain.ts)
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayServer } from '../../ai-nexus-gateway/src/server/gatewayMain.ts';
import { createChatbotServer } from '../server/chatbotMain.ts';
import { InvocationState } from '../protocol/index.ts';
import {
  resolveIdentityPresence,
  getPresenceBadgeMeta,
  getThreeTierAvailability,
} from '../utils/presence.ts';

describe('AI Nexus Presence Resolution & Three-Tier Availability Unit Tests', () => {
  it('Never reports ONLINE for seeded identities when Gateway is unreachable', () => {
    const seededIdentity = {
      aiId: 'ai_alice',
      ownerUserId: 'usr_alice',
      ownerDisplayName: 'Alice Mercer',
      aiName: 'Alice AI',
      handle: '@alice',
      publicKey: 'ed25519_pub_alice',
      capabilities: ['scheduling'],
      endpointUrl: 'ws://localhost:4000/ws/node?aiId=ai_alice',
      online: true, // Seeded true
      registeredAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };

    const offlineGateway = { connected: false, reconnecting: false };
    assert.equal(resolveIdentityPresence(seededIdentity, offlineGateway), 'UNAVAILABLE');
    assert.equal(getPresenceBadgeMeta('UNAVAILABLE').label, 'Unavailable');

    const reconnectingGateway = { connected: false, reconnecting: true };
    assert.equal(resolveIdentityPresence(seededIdentity, reconnectingGateway), 'CONNECTING');
    assert.equal(getPresenceBadgeMeta('CONNECTING').label, 'Connecting…');

    const onlineGateway = { connected: true, reconnecting: false };
    assert.equal(
      resolveIdentityPresence({ ...seededIdentity, presenceState: 'ONLINE' }, onlineGateway),
      'ONLINE'
    );
    assert.equal(
      resolveIdentityPresence(
        { ...seededIdentity, online: false, presenceState: 'OFFLINE' },
        onlineGateway
      ),
      'OFFLINE'
    );
    assert.equal(
      resolveIdentityPresence(
        { ...seededIdentity, online: false, presenceState: 'UNKNOWN' },
        onlineGateway
      ),
      'UNKNOWN'
    );

    const tiersOffline = getThreeTierAvailability(seededIdentity as any, offlineGateway);
    assert.equal(tiersOffline.localAiAvailable, true);
    assert.equal(tiersOffline.gatewayState, 'UNAVAILABLE');
    assert.equal(tiersOffline.remoteNodeState, 'UNAVAILABLE');
  });
});

describe('AI Nexus Two-Server Architecture & Cross-Port Integration Suite', () => {
  it('1. Gateway starts and operates independently without Chatbot running', async () => {
    const gateway = await createGatewayServer({
      port: 0,
      host: '127.0.0.1',
      allowedOrigins: 'http://localhost:3000',
      wsPath: '/ws/node',
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      const healthRes = await fetch(`${baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const health = await healthRes.json();
      assert.equal(health.status, 'OK');
      assert.equal(health.service, 'ai-nexus-gateway');
      assert.equal(health.databaseStatus, 'READY');

      const readyRes = await fetch(`${baseUrl}/ready`);
      assert.equal(readyRes.status, 200);
      const ready = await readyRes.json();
      assert.equal(ready.ready, true);
      assert.equal(ready.checks.identityRegistry, 'READY');
      assert.equal(ready.checks.messageRouter, 'READY');
      assert.equal(ready.checks.offlineQueue, 'READY');
      assert.equal(ready.checks.webSocketTransport, 'READY');
    } finally {
      await gateway.close();
    }
  });

  it('2. Chatbot starts independently when Gateway is stopped, reports Gateway UNAVAILABLE in /health & bootstrap, and fails remote invocation honestly without faking responses', async () => {
    // Point Chatbot to an unused local port where NO Gateway is running
    const deadGatewayUrl = 'http://127.0.0.1:49999';
    const deadWsUrl = 'ws://127.0.0.1:49999/ws/node';

    const chatbot = await createChatbotServer({
      port: 0,
      host: '127.0.0.1',
      gatewayInternalUrl: deadGatewayUrl,
      gatewayPublicHttpUrl: deadGatewayUrl,
      gatewayWsUrl: deadWsUrl,
      attachViteMiddleware: false,
    });

    try {
      const chatbotUrl = `http://127.0.0.1:${chatbot.port}`;

      // 1) Verify Chatbot /health succeeds while reporting gatewayDependency.connected = false
      const healthRes = await fetch(`${chatbotUrl}/health`);
      assert.equal(healthRes.status, 200);
      const health = await healthRes.json();
      assert.equal(health.status, 'OK');
      assert.equal(health.service, 'ai-nexus-chatbot');
      assert.equal(health.gatewayDependency.connected, false);
      assert.equal(health.gatewayDependency.status, 'UNAVAILABLE');
      assert.equal(health.gatewayDependency.verifiedPresenceByAiId.ai_alice, 'UNAVAILABLE');
      assert.equal(health.gatewayDependency.verifiedPresenceByAiId.ai_bob, 'UNAVAILABLE');
      assert.equal(health.gatewayDependency.verifiedPresenceByAiId.ai_charlie, 'UNAVAILABLE');

      // 1b) Verify bootstrap never claims Alice, Bob, or Charlie are ONLINE when Gateway is unreachable
      const bootRes = await fetch(`${chatbotUrl}/api/chatbot/bootstrap`);
      const bootData = await bootRes.json();
      assert.equal(bootData.gatewayStatus.connected, false);
      for (const id of bootData.identities) {
        assert.equal(id.online, false);
        assert.equal(id.presenceState, 'UNAVAILABLE');
        assert.equal(id.localRuntimeAvailable, true);
        assert.equal(id.remoteNodeAvailable, false);
        assert.equal(id.gatewayAvailable, false);
      }

      // 2) Verify local Personal AI conversation still works when Gateway is down
      const localChatRes = await fetch(`${chatbotUrl}/api/chatbot/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv_alice_main',
          senderAiId: 'ai_alice',
          content: 'Summarize my local Q4 launch priorities.',
        }),
      });
      assert.equal(localChatRes.status, 200);
      const localChatData = await localChatRes.json();
      assert.equal(localChatData.messagesAdded.length, 2);
      assert.equal(localChatData.messagesAdded[1].role, 'assistant');

      // 3) Verify remote AI invocation (/ask @bob ...) fails honestly with gatewayUnavailable = true
      const remoteAskRes = await fetch(`${chatbotUrl}/api/chatbot/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv_alice_main',
          senderAiId: 'ai_alice',
          content: '/ask @bob What is your availability tomorrow for a meeting?',
        }),
      });
      assert.equal(remoteAskRes.status, 200);
      const remoteAskData = await remoteAskRes.json();
      assert.equal(remoteAskData.gatewayUnavailable, true);
      const errReply = remoteAskData.messagesAdded[1];
      assert.equal(errReply.role, 'system');
      assert.match(errReply.content, /GATEWAY_UNAVAILABLE/);
    } finally {
      await chatbot.close();
    }
  });

  it('3. Full End-to-End Cross-Process Invocation: Alice AI (Chatbot Server) -> Gateway HTTP API -> Gateway WebSocket (/ws/node) -> Bob AI Node -> Policy Engine & Minimization -> Gateway -> Alice AI Conversation', async () => {
    // 1) Start independent Gateway server
    const gateway = await createGatewayServer({
      port: 0,
      host: '127.0.0.1',
      allowedOrigins: 'http://localhost:3000',
      wsPath: '/ws/node',
    });

    const gatewayHttpUrl = `http://127.0.0.1:${gateway.port}`;
    const gatewayWsUrl = `ws://127.0.0.1:${gateway.port}/ws/node`;

    // 2) Start independent Chatbot server configured to talk to Gateway over HTTP & WS
    const chatbot = await createChatbotServer({
      port: 0,
      host: '127.0.0.1',
      gatewayInternalUrl: gatewayHttpUrl,
      gatewayPublicHttpUrl: gatewayHttpUrl,
      gatewayWsUrl,
      attachViteMiddleware: false,
    });

    try {
      const chatbotUrl = `http://127.0.0.1:${chatbot.port}`;

      // Ensure all Personal AI nodes register over HTTP and connect over WebSocket
      const synced = await chatbot.syncNodesWithGateway();
      assert.equal(synced, true);

      // Verify Gateway /health shows 3 active authenticated WebSocket node connections
      const gwHealthRes = await fetch(`${gatewayHttpUrl}/health`);
      const gwHealth = await gwHealthRes.json();
      assert.equal(gwHealth.status, 'OK');
      assert.equal(gwHealth.registeredIdentities, 3);
      assert.equal(gwHealth.activeNodeConnections, 3);

      // Verify Chatbot /health shows gatewayDependency.connected = true
      const cbHealthRes = await fetch(`${chatbotUrl}/health`);
      const cbHealth = await cbHealthRes.json();
      assert.equal(cbHealth.status, 'OK');
      assert.equal(cbHealth.gatewayDependency.connected, true);
      assert.equal(cbHealth.gatewayDependency.status, 'CONNECTED');
      assert.equal(cbHealth.gatewayDependency.authenticatedNodeWebSockets.length, 3);
      assert.equal(cbHealth.gatewayDependency.verifiedPresenceByAiId.ai_alice, 'ONLINE');
      assert.equal(cbHealth.gatewayDependency.verifiedPresenceByAiId.ai_bob, 'ONLINE');
      assert.equal(cbHealth.gatewayDependency.verifiedPresenceByAiId.ai_charlie, 'ONLINE');

      // 3) Trigger real remote invocation from Alice AI to Bob AI via Chatbot API
      const askRes = await fetch(`${chatbotUrl}/api/chatbot/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv_alice_main',
          senderAiId: 'ai_alice',
          content: '/ask @bob What is your availability tomorrow for a meeting?',
          enableAutonomousFollowUp: false,
        }),
      });
      assert.equal(askRes.status, 200);
      const askData = await askRes.json();
      assert.equal(Boolean(askData.gatewayUnavailable), false);

      const remoteMsg = askData.messagesAdded.find((m: any) => m.role === 'remote_ai');
      assert.ok(remoteMsg, 'Expected attributed remote_ai message from Bob AI');
      assert.equal(remoteMsg.senderAiId, 'ai_bob');
      assert.match(remoteMsg.content, /According to Bob Chen's AI \(@bob\)/i);
      assert.match(remoteMsg.content, /2:00 PM.*4:00 PM/i);
      // Verify private meeting titles ('Dentist Appointment', 'Sarah') were redacted
      assert.doesNotMatch(remoteMsg.content, /Dentist/i);
      assert.doesNotMatch(remoteMsg.content, /Sarah/i);

      // Verify full state machine transitions recorded on the Gateway
      const record = remoteMsg.invocationRecord;
      assert.ok(record);
      assert.equal(record.state, InvocationState.COMPLETED);
      const statesVisited = record.transitions.map((t: any) => t.state);
      for (const expectedState of [
        InvocationState.CREATED,
        InvocationState.SENT,
        InvocationState.RECEIVED,
        InvocationState.AUTHENTICATED,
        InvocationState.AUTHORIZED,
        InvocationState.EXECUTING,
        InvocationState.RESPONDING,
        InvocationState.COMPLETED,
      ]) {
        assert.ok(
          statesVisited.includes(expectedState),
          `Expected transition '${expectedState}' in [${statesVisited.join(', ')}]`
        );
      }

      // 4) Test Deterministic Policy Engine DENY across WebSocket (/ask @bob private notes)
      const denyRes = await fetch(`${chatbotUrl}/api/chatbot/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv_alice_main',
          senderAiId: 'ai_alice',
          content: '/ask @bob What is in your private notes?',
        }),
      });
      const denyData = await denyRes.json();
      const denyMsg = denyData.messagesAdded.find((m: any) => m.role === 'remote_ai');
      assert.ok(denyMsg);
      assert.equal(denyMsg.invocationRecord.state, InvocationState.REJECTED);
      assert.match(denyMsg.content, /AUTHORIZATION_DENIED/);

      // 5) Test Offline Queueing when Bob disconnects WebSocket, followed by automatic drain on reconnect
      await fetch(`${chatbotUrl}/api/chatbot/nodes/ai_bob/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ online: false }),
      });

      const offlineAskRes = await fetch(`${chatbotUrl}/api/chatbot/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'conv_alice_main',
          senderAiId: 'ai_alice',
          content: '/ask @bob Are you free tomorrow at 3 PM PST?',
          enableAutonomousFollowUp: false,
        }),
      });
      const offlineAskData = await offlineAskRes.json();
      const queuedMsg = offlineAskData.messagesAdded.find((m: any) => m.role === 'remote_ai');
      assert.ok(queuedMsg);
      assert.equal(queuedMsg.invocationRecord.queuedOffline, true);
      const queuedRequestId = queuedMsg.invocationRecord.requestId;

      // Reconnect Bob's node -> Gateway drains offline queue over WebSocket -> Bob processes & completes
      await fetch(`${chatbotUrl}/api/chatbot/nodes/ai_bob/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ online: true }),
      });

      // Wait for async WebSocket drain & LLM/policy response round-trip
      let drainedRecord: any = null;
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((r) => setTimeout(r, 250));
        const gwInvRes = await fetch(`${gatewayHttpUrl}/api/v1/invocations`);
        const gwInvData = await gwInvRes.json();
        drainedRecord = gwInvData.invocations.find(
          (i: any) => i.requestId === queuedRequestId
        );
        if (drainedRecord?.state === InvocationState.COMPLETED) break;
      }
      assert.ok(drainedRecord);
      assert.equal(drainedRecord.state, InvocationState.COMPLETED);
    } finally {
      await chatbot.close();
      await gateway.close();
    }
  });
});

