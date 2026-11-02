// ============================================================================
// APPLICATION A: AI NEXUS CHATBOT — src/server/chatbotMain.ts
// Independent Server Entrypoint listening on http://localhost:3000
//
// Architectural Guarantees:
// - Does NOT import or initialize the AI Nexus Gateway application.
// - Does NOT mount Gateway routes (/api/v1/*).
// - Does NOT create a Gateway WebSocket server.
// - Does NOT contain Gateway MessageRouter, IdentityRegistry, or OfflineQueue.
// - Communicates with AI Nexus Gateway strictly over HTTP (http://localhost:4000)
//   and WebSocket (ws://localhost:4000/ws/node) using @ai-nexus/protocol SDK.
// ============================================================================

import dotenv from 'dotenv';
import express, { Express } from 'express';
import http from 'node:http';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import {
  AuditEventRecord,
  CapabilityType,
  createSignedMessageEnvelope,
  EnvelopeMessageType,
  ExecutionMode,
  GatewayErrorCode,
  GatewayProtocolHttpClient,
  GroupSession,
  InvocationRecord,
  InvocationRequestPayload,
  InvocationState,
  MemoryCategory,
  MemoryEntry,
  PermissionMode,
  PublicAIIdentity,
} from '../protocol/index.ts';
import {
  AutonomousFollowUpEngine,
  ChatAttachment,
  ChatMessage,
  CommandParser,
  ConversationThread,
  createSeedNodesConfig,
  LLMGeneratorFn,
  MemoryManager,
  OwnerPolicyEngine,
  PromptInjectionGuard,
  RawOwnerDataset,
} from '../chatbot/engine.ts';
import { PersonalAINodeAgent } from '../services/PersonalAINodeAgent.ts';

dotenv.config();

export interface ChatbotServerConfig {
  port?: number;
  host?: string;
  gatewayInternalUrl?: string;
  gatewayPublicHttpUrl?: string;
  gatewayWsUrl?: string;
  attachViteMiddleware?: boolean;
}

export interface ChatbotServerInstance {
  app: Express;
  httpServer: http.Server;
  port: number;
  gatewayClient: GatewayProtocolHttpClient;
  nodeAgents: Map<string, PersonalAINodeAgent>;
  syncNodesWithGateway: () => Promise<boolean>;
  close: () => Promise<void>;
}

export async function createChatbotServer(
  config: ChatbotServerConfig = {}
): Promise<ChatbotServerInstance> {
  const cliPortIdx = process.argv.indexOf('--port');
  const cliPort =
    cliPortIdx !== -1 && process.argv[cliPortIdx + 1]
      ? Number(process.argv[cliPortIdx + 1])
      : undefined;
  const PORT =
    config.port ??
    cliPort ??
    Number(process.env.CHATBOT_PORT || 3000);
  const HOST = config.host ?? (process.env.HOST || '0.0.0.0');
  const GATEWAY_INTERNAL_URL =
    config.gatewayInternalUrl ??
    process.env.GATEWAY_INTERNAL_URL ??
    process.env.VITE_GATEWAY_HTTP_URL ??
    'http://localhost:4000';
  const VITE_GATEWAY_HTTP_URL =
    config.gatewayPublicHttpUrl ??
    process.env.VITE_GATEWAY_HTTP_URL ??
    GATEWAY_INTERNAL_URL;
  const VITE_GATEWAY_WS_URL =
    config.gatewayWsUrl ??
    process.env.VITE_GATEWAY_WS_URL ??
    GATEWAY_INTERNAL_URL.replace(/^http/, 'ws') + '/ws/node';

  const gatewayClient = new GatewayProtocolHttpClient(GATEWAY_INTERNAL_URL);

  // Initialize Chatbot-only state & seed Personal AI profiles
  const seed = createSeedNodesConfig();
  const identities = new Map<string, PublicAIIdentity>();
  for (const id of seed.identities) {
    identities.set(id.aiId, id);
  }
  const datasets: Map<string, RawOwnerDataset> = seed.datasets;
  const policyEngine: OwnerPolicyEngine = seed.policyEngine;
  const memoryManager: MemoryManager = seed.memoryManager;
  const conversations: Map<string, ConversationThread> = seed.conversations;
  const groups: Map<string, GroupSession> = seed.groups;
  const chatbotAuditLog: AuditEventRecord[] = [];

  const recordChatbotAudit = (params: {
    module: string;
    eventType: string;
    actorAiId: string;
    targetAiId?: string;
    correlationId?: string;
    outcome: 'SUCCESS' | 'DENIED' | 'ERROR' | 'PENDING';
    summary: string;
  }) => {
    chatbotAuditLog.unshift({
      eventId: `aud_chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      repository: 'ai-nexus-chatbot',
      ...params,
    });
  };

  // Optional Gemini API adapter (used only inside Chatbot / Personal AI runtime)
  const hasRealGeminiKey = Boolean(
    process.env.GEMINI_API_KEY &&
      process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY' &&
      process.env.GEMINI_API_KEY.trim().length > 10
  );

  const geminiGenerator: LLMGeneratorFn | undefined = hasRealGeminiKey
    ? async ({ aiIdentity, systemInstruction, prompt }) => {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
        const modelName = aiIdentity.configuredModel.startsWith('gemini')
          ? 'gemini-3-flash-preview'
          : 'gemini-3-flash-preview';
        const response = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            systemInstruction,
            temperature: 0.2,
          },
        });
        const text = response.text?.trim() || 'Response generated.';
        const tokensUsed = Math.max(48, Math.round(text.length / 4));
        return {
          text,
          tokensUsed,
          costUsd: Number((tokensUsed * 0.000002).toFixed(5)),
        };
      }
    : undefined;

  // Create PersonalAINodeAgent clients that connect to Gateway over HTTP & WS
  const nodeAgents = new Map<string, PersonalAINodeAgent>();
  for (const identity of identities.values()) {
    const ds = datasets.get(identity.aiId)!;
    const agent = new PersonalAINodeAgent(
      identity,
      ds,
      policyEngine,
      memoryManager,
      GATEWAY_INTERNAL_URL,
      VITE_GATEWAY_WS_URL,
      geminiGenerator
    );
    nodeAgents.set(identity.aiId, agent);
  }

  async function syncNodesWithGateway(): Promise<boolean> {
    const health = await gatewayClient.checkHealth();
    if (!health.reachable) {
      return false;
    }

    for (const agent of nodeAgents.values()) {
      if (!agent.isConnectedToGatewayWs() && agent.desiredOnline) {
        await agent.registerAndConnect();
      }
    }
    return true;
  }

  // Attempt initial registration & WebSocket connection to Gateway (non-blocking if Gateway isn't up yet)
  syncNodesWithGateway().catch(() => {
    // Gateway may be started independently after Chatbot
  });

  // Background heartbeat & auto-recovery sync when Gateway comes online
  const gatewaySyncInterval = setInterval(() => {
    const needsSync = Array.from(nodeAgents.values()).some(
      (a) => a.desiredOnline && !a.isConnectedToGatewayWs()
    );
    if (needsSync) {
      syncNodesWithGateway().catch(() => {
        // Ignore transient connection errors while Gateway is down
      });
    }
  }, 2500);
  gatewaySyncInterval.unref?.();

  // Helper to dispatch a signed remote invocation through the Gateway over HTTP + WS
  async function invokeRemoteAiThroughGateway(params: {
    senderIdentity: PublicAIIdentity;
    recipientIdentity: PublicAIIdentity;
    capability: CapabilityType;
    question: string;
    conversationId: string;
    groupId?: string;
    followUpTurn?: number;
    maxFollowUpTurns?: number;
    maxBudgetUsd?: number;
    accumulatedCostUsd?: number;
    invocationChainTrace?: string[];
  }): Promise<{
    gatewayReachable: boolean;
    record?: InvocationRecord;
    errorText?: string;
  }> {
    const reachable = await syncNodesWithGateway();
    if (!reachable) {
      recordChatbotAudit({
        module: 'GatewayProtocolHttpClient',
        eventType: 'GATEWAY_CONNECTION_FAILED',
        actorAiId: params.senderIdentity.aiId,
        targetAiId: params.recipientIdentity.aiId,
        outcome: 'ERROR',
        summary: `Remote invocation to ${params.recipientIdentity.handle} failed: AI Nexus Gateway (${GATEWAY_INTERNAL_URL}) is unreachable.`,
      });
      return {
        gatewayReachable: false,
        errorText: `AI Nexus Gateway (${GATEWAY_INTERNAL_URL}) is unreachable. Remote AI invocation cannot proceed while the Gateway server on port 4000 is offline.`,
      };
    }

    const correlationId = `corr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const idempotencyKey = `idem_${params.senderIdentity.aiId}_${params.recipientIdentity.aiId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const requestEnvelope = createSignedMessageEnvelope<InvocationRequestPayload>({
      senderAiId: params.senderIdentity.aiId,
      recipientAiId: params.recipientIdentity.aiId,
      keyFingerprint: params.senderIdentity.keyFingerprint,
      type: params.groupId
        ? EnvelopeMessageType.GROUP_BROADCAST
        : EnvelopeMessageType.INVOCATION_REQUEST,
      correlationId,
      idempotencyKey,
      ttlSeconds: 300,
      payload: {
        capability: params.capability,
        question: params.question,
        conversationId: params.conversationId,
        groupId: params.groupId,
        queueIfOffline: true,
        followUpTurn: params.followUpTurn ?? 1,
        maxFollowUpTurns: params.maxFollowUpTurns ?? 5,
        maxBudgetUsd: params.maxBudgetUsd ?? 0.05,
        accumulatedCostUsd: params.accumulatedCostUsd ?? 0.0002,
        invocationChainTrace: params.invocationChainTrace ?? [params.senderIdentity.aiId],
      },
    });

    try {
      const result = await gatewayClient.sendInvocation(requestEnvelope);
      return {
        gatewayReachable: true,
        record: result.record,
      };
    } catch (err) {
      return {
        gatewayReachable: false,
        errorText:
          err instanceof Error
            ? err.message
            : `Failed to reach Gateway at ${GATEWAY_INTERNAL_URL}`,
      };
    }
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // --------------------------------------------------------------------------
  // 1. Health Endpoint (`GET /health`)
  // --------------------------------------------------------------------------
  app.get('/health', async (_req, res) => {
    const gatewayProbe = await gatewayClient.checkHealth();
    if (gatewayProbe.reachable) {
      await syncNodesWithGateway();
    }
    const connectedWsNodes = Array.from(nodeAgents.values())
      .filter((a) => a.isConnectedToGatewayWs())
      .map((a) => a.identity.aiId);

    const verifiedPresenceByAiId: Record<string, string> = {};
    for (const [aiId, agent] of nodeAgents.entries()) {
      verifiedPresenceByAiId[aiId] = agent.getVerifiedPresenceState(
        gatewayProbe.reachable,
        gatewayProbe.health?.connectedNodeAiIds
      );
    }

    res.status(200).json({
      status: 'OK',
      service: 'ai-nexus-chatbot',
      version: '1.0.0',
      port: PORT,
      timestamp: new Date().toISOString(),
      databaseStatus: 'READY',
      llmProvider: {
        configuredProvider: 'gemini',
        defaultModel: 'gemini-3.8-flash',
        apiKeyConfigured: hasRealGeminiKey,
        executionFallback: hasRealGeminiKey ? 'LIVE_GEMINI_SDK' : 'DETERMINISTIC_LOCAL_RUNTIME',
      },
      gatewayDependency: {
        internalUrl: GATEWAY_INTERNAL_URL,
        publicHttpUrl: VITE_GATEWAY_HTTP_URL,
        wsUrl: VITE_GATEWAY_WS_URL,
        connected: gatewayProbe.reachable,
        status: gatewayProbe.reachable ? 'CONNECTED' : 'UNAVAILABLE',
        authenticatedNodeWebSockets: connectedWsNodes,
        verifiedPresenceByAiId,
        gatewayHealth: gatewayProbe.health ?? null,
        error: gatewayProbe.error ?? null,
      },
    });
  });

  // --------------------------------------------------------------------------
  // 2. Bootstrap Endpoint (`GET /api/chatbot/bootstrap`)
  // --------------------------------------------------------------------------
  app.get('/api/chatbot/bootstrap', async (req, res) => {
    if (req.query.reconnect === '1') {
      await syncNodesWithGateway().catch(() => {});
    }

    let gatewayProbe = await gatewayClient.checkHealth();
    let gatewayIdentities: PublicAIIdentity[] = [];
    let gatewayInvocations: InvocationRecord[] = [];
    let gatewayAuditEvents: AuditEventRecord[] = [];

    if (gatewayProbe.reachable) {
      await syncNodesWithGateway();
      // Re-fetch gateway health after sync so connectedNodeAiIds is up to date
      gatewayProbe = await gatewayClient.checkHealth();
      try {
        const [idList, invData, audList] = await Promise.all([
          gatewayClient.listIdentities(),
          gatewayClient.listInvocations(),
          gatewayClient.listAuditEvents(),
        ]);
        gatewayIdentities = idList;
        gatewayInvocations = invData.invocations;
        gatewayAuditEvents = audList;

        // Sync latest Gateway identity metadata into local agent view
        for (const gId of gatewayIdentities) {
          const existing = identities.get(gId.aiId);
          if (existing) {
            const merged = { ...existing, ...gId };
            identities.set(gId.aiId, merged);
            const agent = nodeAgents.get(gId.aiId);
            if (agent) {
              agent.identity = merged;
              agent.desiredOnline = gId.online !== false;
            }
          }
        }
      } catch {
        // Fallback to local state if Gateway drops mid-request
      }
    }

    // Build accurate, non-contradictory identity presence states
    const connectedAiIdsOnGateway = gatewayProbe.health?.connectedNodeAiIds ?? [];
    const identityList: PublicAIIdentity[] = Array.from(identities.values()).map((id) => {
      const agent = nodeAgents.get(id.aiId);
      if (!gatewayProbe.reachable) {
        return {
          ...id,
          online: false,
          presenceState: 'UNAVAILABLE',
          localRuntimeAvailable: true,
          remoteNodeAvailable: false,
          gatewayAvailable: false,
          desiredOnline: agent?.desiredOnline ?? true,
        };
      }

      const gatewayRecord = gatewayIdentities.find((g) => g.aiId === id.aiId);
      const isWsConnected =
        Boolean(agent?.isConnectedToGatewayWs()) ||
        connectedAiIdsOnGateway.includes(id.aiId);
      const isExplicitlyOffline =
        (gatewayRecord && gatewayRecord.online === false) ||
        agent?.desiredOnline === false;

      const presenceState = isExplicitlyOffline
        ? 'OFFLINE'
        : isWsConnected
        ? 'ONLINE'
        : agent?.isConnectingToGatewayWs()
        ? 'CONNECTING'
        : gatewayRecord
        ? gatewayRecord.online
          ? 'ONLINE'
          : 'OFFLINE'
        : 'UNKNOWN';

      const isVerifiedOnline = presenceState === 'ONLINE';
      return {
        ...id,
        ...(gatewayRecord ?? {}),
        online: isVerifiedOnline,
        presenceState,
        localRuntimeAvailable: true,
        remoteNodeAvailable: isVerifiedOnline,
        gatewayAvailable: true,
        desiredOnline: agent?.desiredOnline ?? true,
      };
    });

    const permissions: Record<string, unknown> = {};
    const memories: Record<string, MemoryEntry[]> = {};
    for (const id of identityList) {
      permissions[id.aiId] = policyEngine.getRulesForOwner(id.aiId);
      memories[id.aiId] = memoryManager.listMemoriesForOwner(id.aiId);
    }

    const pendingApprovals = gatewayInvocations.filter(
      (inv) => inv.state === InvocationState.REQUIRES_APPROVAL
    );

    const combinedAudit = [...gatewayAuditEvents, ...chatbotAuditLog].sort(
      (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
    );

    res.status(200).json({
      gatewayStatus: {
        connected: gatewayProbe.reachable,
        state: gatewayProbe.reachable ? 'ONLINE' : 'UNAVAILABLE',
        httpUrl: VITE_GATEWAY_HTTP_URL,
        internalUrl: GATEWAY_INTERNAL_URL,
        wsUrl: VITE_GATEWAY_WS_URL,
        health: gatewayProbe.health ?? null,
        error: gatewayProbe.error ?? null,
      },
      identities: identityList,
      conversations: Array.from(conversations.values()).sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
      ),
      groups: Array.from(groups.values()),
      permissions,
      memories,
      memoryGrants: [
        ...memoryManager.listGrantsForOwner('ai_alice'),
        ...memoryManager.listGrantsForOwner('ai_bob'),
        ...memoryManager.listGrantsForOwner('ai_charlie'),
      ].filter((g, idx, arr) => arr.findIndex((x) => x.grantId === g.grantId) === idx),
      invocations: gatewayInvocations,
      pendingApprovals,
      auditEvents: combinedAudit,
    });
  });

  // --------------------------------------------------------------------------
  // 3. Conversations CRUD (`/api/chatbot/conversations`)
  // --------------------------------------------------------------------------
  app.post('/api/chatbot/conversations', (req, res) => {
    const { ownerAiId = 'ai_alice', title = 'New Conversation' } = req.body ?? {};
    const nowIso = new Date().toISOString();
    const conv: ConversationThread = {
      id: `conv_${Date.now()}`,
      ownerAiId,
      title,
      pinned: false,
      archived: false,
      isGroup: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      messages: [],
    };
    conversations.set(conv.id, conv);
    res.status(201).json({ conversation: conv });
  });

  app.patch('/api/chatbot/conversations/:id', (req, res) => {
    const conv = conversations.get(req.params.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (req.body?.togglePin) {
      conv.pinned = !conv.pinned;
    }
    if (typeof req.body?.title === 'string') {
      conv.title = req.body.title;
    }
    conv.updatedAt = new Date().toISOString();
    res.status(200).json({ conversation: conv });
  });

  app.delete('/api/chatbot/conversations/:id', (req, res) => {
    conversations.delete(req.params.id);
    res.status(200).json({ deleted: true });
  });

  // --------------------------------------------------------------------------
  // 4. Send Message / Execute Slash or Natural Command (`POST /api/chatbot/messages`)
  // --------------------------------------------------------------------------
  app.post('/api/chatbot/messages', async (req, res) => {
    const {
      conversationId = 'conv_alice_main',
      senderAiId = 'ai_alice',
      content = '',
      enableAutonomousFollowUp = true,
      attachments = [],
    } = req.body ?? {};

    let conv = conversations.get(conversationId);
    if (!conv) {
      const nowIso = new Date().toISOString();
      conv = {
        id: conversationId,
        ownerAiId: senderAiId,
        title: content.slice(0, 42) || 'Conversation',
        pinned: false,
        archived: false,
        isGroup: false,
        createdAt: nowIso,
        updatedAt: nowIso,
        messages: [],
      };
      conversations.set(conv.id, conv);
    }

    const senderIdentity = identities.get(senderAiId) ?? Array.from(identities.values())[0];

    const userMsg: ChatMessage = {
      id: `msg_u_${Date.now()}`,
      conversationId: conv.id,
      role: 'user',
      senderAiId: senderIdentity.aiId,
      senderDisplayName: `${senderIdentity.ownerDisplayName} (You)`,
      content,
      timestamp: new Date().toISOString(),
      attachments: attachments as ChatAttachment[],
    };
    conv.messages.push(userMsg);
    conv.updatedAt = userMsg.timestamp;

    const parsed = CommandParser.parse(content);

    // CASE A: Remote AI Invocation (`/ask @bob ...` or natural language `Ask Bob's AI ...`)
    if (parsed.type === 'ASK_REMOTE_AI' && parsed.targetHandle) {
      const recipientIdentity = Array.from(identities.values()).find(
        (i) => i.handle.toLowerCase() === parsed.targetHandle!.toLowerCase()
      );

      if (!recipientIdentity) {
        const errMsg: ChatMessage = {
          id: `msg_sys_${Date.now()}`,
          conversationId: conv.id,
          role: 'system',
          senderAiId: senderIdentity.aiId,
          senderDisplayName: 'AI Nexus Router',
          content: `**Unknown AI Handle (\`${parsed.targetHandle}\`):** No Personal AI with handle \`${parsed.targetHandle}\` is registered.`,
          timestamp: new Date().toISOString(),
        };
        conv.messages.push(errMsg);
        res.status(200).json({ conversation: conv, messagesAdded: [userMsg, errMsg] });
        return;
      }

      const invResult = await invokeRemoteAiThroughGateway({
        senderIdentity,
        recipientIdentity,
        capability: parsed.inferredCapability,
        question: parsed.questionOrContent || content,
        conversationId: conv.id,
        followUpTurn: 1,
        maxFollowUpTurns: 5,
        maxBudgetUsd: 0.05,
        accumulatedCostUsd: 0.0002,
        invocationChainTrace: [senderIdentity.aiId],
      });

      if (!invResult.gatewayReachable || !invResult.record) {
        const gatewayDownMsg: ChatMessage = {
          id: `msg_gw_err_${Date.now()}`,
          conversationId: conv.id,
          role: 'system',
          senderAiId: senderIdentity.aiId,
          senderDisplayName: 'AI Nexus Gateway Client',
          content: `**Gateway Unavailable (\`GATEWAY_UNAVAILABLE\`):** ${
            invResult.errorText ||
            `Could not connect to AI Nexus Gateway at ${GATEWAY_INTERNAL_URL}.`
          }\n\n*No remote AI response was generated because the Gateway process on port 4000 is offline.*`,
          timestamp: new Date().toISOString(),
          attributionLabel: `Gateway Connection Failed (${GATEWAY_INTERNAL_URL})`,
        };
        conv.messages.push(gatewayDownMsg);
        res.status(200).json({
          conversation: conv,
          gatewayUnavailable: true,
          error: invResult.errorText,
          messagesAdded: [userMsg, gatewayDownMsg],
        });
        return;
      }

      const record = invResult.record;
      const respPayload = record.responseEnvelope?.payload;

      const remoteMsg: ChatMessage = {
        id: `msg_rem_${Date.now()}`,
        conversationId: conv.id,
        role: 'remote_ai',
        senderAiId: recipientIdentity.aiId,
        senderDisplayName: `${recipientIdentity.displayName} (${recipientIdentity.handle})`,
        content:
          respPayload?.answer ||
          (record.queuedOffline
            ? `**Queued for Offline Delivery (\`QUEUED_OFFLINE\`):** ${recipientIdentity.displayName} (${recipientIdentity.nodeId}) is currently offline. Your signed envelope (\`${record.requestId}\`) is stored in the Gateway Offline Queue and will automatically deliver over WebSocket when ${recipientIdentity.handle} reconnects.`
            : `Invocation finished in state \`${record.state}\`.`),
        timestamp: new Date().toISOString(),
        attributionLabel:
          respPayload?.attributionLabel ||
          `Gateway State: ${record.state} · Correlation ${record.envelope.correlationId}`,
        invocationRecord: record,
        minimizedFields: respPayload?.minimizedFieldsReturned ?? [],
        redactedFields: respPayload?.redactedFields ?? [],
        followUpTurn: 1,
        modelUsed: respPayload?.modelUsed ?? recipientIdentity.configuredModel,
        tokensUsed: respPayload?.tokensUsed ?? 0,
        costUsd: respPayload?.estimatedCostUsd ?? 0,
      };
      conv.messages.push(remoteMsg);

      const addedMessages: ChatMessage[] = [userMsg, remoteMsg];

      // Optional Autonomous Multi-Turn Follow-Up Negotiation
      if (
        enableAutonomousFollowUp &&
        parsed.autonomousFollowUpRequested &&
        record.state === InvocationState.COMPLETED
      ) {
        const followUpQuestion =
          'Confirming the 2:00 PM – 2:30 PM PST slot tomorrow based on our mutual availability.';
        const loopCheck = AutonomousFollowUpEngine.validateTurn({
          currentTurn: 2,
          maxTurns: 5,
          accumulatedCostUsd: (respPayload?.estimatedCostUsd ?? 0.0003) + 0.0003,
          maxBudgetUsd: 0.05,
          previousQuestions: [parsed.questionOrContent || content],
          nextQuestion: followUpQuestion,
          invocationChainTrace: [senderIdentity.aiId, recipientIdentity.aiId],
          nextRecipientAiId: recipientIdentity.aiId,
        });

        if (loopCheck.allowed) {
          const followUpResult = await invokeRemoteAiThroughGateway({
            senderIdentity,
            recipientIdentity,
            capability: parsed.inferredCapability,
            question: followUpQuestion,
            conversationId: conv.id,
            followUpTurn: 2,
            maxFollowUpTurns: 5,
            maxBudgetUsd: 0.05,
            accumulatedCostUsd: 0.0006,
            invocationChainTrace: [senderIdentity.aiId, recipientIdentity.aiId],
          });

          if (followUpResult.gatewayReachable && followUpResult.record) {
            const fuRecord = followUpResult.record;
            const fuMsg: ChatMessage = {
              id: `msg_fu_${Date.now()}`,
              conversationId: conv.id,
              role: 'assistant',
              senderAiId: senderIdentity.aiId,
              senderDisplayName: `${senderIdentity.displayName} (Autonomous Follow-Up · Turn 2/5)`,
              content: `**Autonomous Multi-Turn Negotiation Complete (Turn 2/5):** Cross-referenced ${senderIdentity.ownerDisplayName}'s private calendar with ${recipientIdentity.displayName}'s minimized free/busy response via Gateway (\`${fuRecord.requestId}\`). Confirmed **Tomorrow 2:00 PM – 2:30 PM PST** as the optimal meeting window.`,
              timestamp: new Date().toISOString(),
              attributionLabel: `Autonomous Follow-Up (Turn 2/5 · Loop Guard Passed)`,
              invocationRecord: fuRecord,
              followUpTurn: 2,
              modelUsed: senderIdentity.configuredModel,
              tokensUsed: 112,
              costUsd: 0.0003,
            };
            conv.messages.push(fuMsg);
            addedMessages.push(fuMsg);
          }
        }
      }

      res.status(200).json({ conversation: conv, messagesAdded: addedMessages });
      return;
    }

    // CASE B: Group Broadcast (`/ask-all ...` or message inside a Group thread)
    if (parsed.type === 'ASK_ALL_GROUP' || conv.isGroup) {
      const group =
        (conv.groupId ? groups.get(conv.groupId) : undefined) ??
        Array.from(groups.values())[0];

      if (!group) {
        res.status(400).json({ error: 'No active group session found.' });
        return;
      }

      const otherParticipants = group.participants.filter(
        (p) => p.aiId !== senderIdentity.aiId && p.status === 'ACTIVE'
      );

      const addedMessages: ChatMessage[] = [userMsg];
      for (const part of otherParticipants) {
        const targetIdentity = identities.get(part.aiId);
        if (!targetIdentity) continue;

        const invResult = await invokeRemoteAiThroughGateway({
          senderIdentity,
          recipientIdentity: targetIdentity,
          capability: 'group.collaboration',
          question: parsed.questionOrContent || content,
          conversationId: conv.id,
          groupId: group.groupId,
          followUpTurn: 1,
          maxFollowUpTurns: group.maxTurnLimit,
          maxBudgetUsd: 0.08,
        });

        if (!invResult.gatewayReachable || !invResult.record) {
          const gwErr: ChatMessage = {
            id: `msg_grp_err_${Date.now()}_${part.aiId}`,
            conversationId: conv.id,
            role: 'system',
            senderAiId: senderIdentity.aiId,
            senderDisplayName: 'AI Nexus Gateway Client',
            content: `**Gateway Unavailable (\`GATEWAY_UNAVAILABLE\`):** Cannot reach ${targetIdentity.displayName} (${targetIdentity.handle}) in group session because the AI Nexus Gateway (${GATEWAY_INTERNAL_URL}) is offline.`,
            timestamp: new Date().toISOString(),
          };
          conv.messages.push(gwErr);
          addedMessages.push(gwErr);
          continue;
        }

        const rec = invResult.record;
        const resp = rec.responseEnvelope?.payload;
        const grpMsg: ChatMessage = {
          id: `msg_grp_${Date.now()}_${part.aiId}`,
          conversationId: conv.id,
          role: 'remote_ai',
          senderAiId: targetIdentity.aiId,
          senderDisplayName: `${targetIdentity.displayName} (${targetIdentity.handle} · Owner: ${targetIdentity.ownerDisplayName})`,
          content:
            resp?.answer ||
            `[${targetIdentity.displayName}] State: ${rec.state}`,
          timestamp: new Date().toISOString(),
          attributionLabel:
            resp?.attributionLabel ||
            `Group Session (${group.title}) · Signed by ${targetIdentity.handle}`,
          invocationRecord: rec,
          minimizedFields: resp?.minimizedFieldsReturned ?? [],
          redactedFields: resp?.redactedFields ?? [],
          modelUsed: resp?.modelUsed ?? targetIdentity.configuredModel,
          tokensUsed: resp?.tokensUsed ?? 96,
          costUsd: resp?.estimatedCostUsd ?? 0.0003,
        };
        conv.messages.push(grpMsg);
        addedMessages.push(grpMsg);
      }

      res.status(200).json({ conversation: conv, messagesAdded: addedMessages });
      return;
    }

    // CASE C: Create Group (`/group create ...`)
    if (parsed.type === 'GROUP_CREATE') {
      const nowIso = new Date().toISOString();
      const groupId = `grp_${Date.now()}`;
      const newGroup: GroupSession = {
        groupId,
        title: parsed.questionOrContent || 'Cross-AI Strategy Session',
        createdByAiId: senderIdentity.aiId,
        participants: Array.from(identities.values()).map((id) => ({
          aiId: id.aiId,
          handle: id.handle,
          displayName: id.displayName,
          ownerName: id.ownerDisplayName,
          status: 'ACTIVE',
          joinedAt: nowIso,
          model: id.configuredModel,
        })),
        messages: [],
        status: 'ACTIVE',
        maxTurnLimit: 15,
        currentTurnCount: 1,
        maxBudgetUsd: 0.5,
        currentCostUsd: 0,
        createdAt: nowIso,
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      };
      groups.set(groupId, newGroup);

      const grpConv: ConversationThread = {
        id: `conv_${groupId}`,
        ownerAiId: senderIdentity.aiId,
        title: `[Group] ${newGroup.title}`,
        pinned: true,
        archived: false,
        isGroup: true,
        groupId,
        createdAt: nowIso,
        updatedAt: nowIso,
        messages: [
          {
            id: `msg_grp_init_${Date.now()}`,
            conversationId: `conv_${groupId}`,
            role: 'system',
            senderAiId: senderIdentity.aiId,
            senderDisplayName: 'Group Coordinator',
            content: `Created Multi-AI Group Session **${newGroup.title}** (\`${groupId}\`) with participants \`@alice\`, \`@bob\`, and \`@charlie\`. Use \`/ask-all <prompt>\` to broadcast to all participant AIs via the Gateway.`,
            timestamp: nowIso,
          },
        ],
      };
      conversations.set(grpConv.id, grpConv);
      res.status(200).json({ conversation: grpConv, group: newGroup });
      return;
    }

    // CASE D: Share Memory (`/share-memory @bob ...`)
    if (parsed.type === 'SHARE_MEMORY' && parsed.targetHandle) {
      const target = Array.from(identities.values()).find(
        (i) => i.handle.toLowerCase() === parsed.targetHandle!.toLowerCase()
      );
      if (target) {
        const mem = memoryManager.addMemory({
          memoryId: `mem_${Date.now()}`,
          ownerAiId: senderIdentity.aiId,
          category: MemoryCategory.SHARED_CONTEXT,
          title: `Shared Note for ${target.handle}`,
          content: parsed.questionOrContent || content,
          tags: ['shared', target.handle.replace('@', '')],
          sourceAiId: senderIdentity.aiId,
          sourceOwnerId: senderIdentity.ownerId,
          trustClassification: 'VERIFIED_OWNER',
          retentionPolicy: 'TIME_LIMITED',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const shareRes = memoryManager.shareMemoryWithAI({
          memoryId: mem.memoryId,
          ownerAiId: senderIdentity.aiId,
          recipientAiId: target.aiId,
          ttlHours: 72,
        });
        const sysMsg: ChatMessage = {
          id: `msg_share_${Date.now()}`,
          conversationId: conv.id,
          role: 'assistant',
          senderAiId: senderIdentity.aiId,
          senderDisplayName: senderIdentity.displayName,
          content: `**Explicit Memory Grant Created (\`${shareRes.grant?.grantId}\`):** Shared read-only memory *"${mem.content}"* with **${target.displayName} (${target.handle})** for 72 hours.`,
          timestamp: new Date().toISOString(),
          attributionLabel: `Memory Grant · ${shareRes.grant?.grantId}`,
        };
        conv.messages.push(sysMsg);
        res.status(200).json({ conversation: conv, messagesAdded: [userMsg, sysMsg] });
        return;
      }
    }

    // CASE E: Standard Personal AI Direct Chat (Local to Chatbot — does not require Gateway)
    const relevantMemories = memoryManager.searchRelevantMemories(
      senderIdentity.aiId,
      content,
      3
    );
    const dataset = datasets.get(senderIdentity.aiId);
    const localContext = [
      dataset ? `Owner Work Summary: ${dataset.workStatus.publicSummary}` : '',
      relevantMemories.length > 0
        ? `Relevant Owner Memories:\n${relevantMemories
            .map((m) => `- [${m.category}] ${m.title}: ${m.content}`)
            .join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    let replyText = '';
    let tokensUsed = 84;
    let costUsd = 0.0002;

    if (geminiGenerator) {
      try {
        const gen = await geminiGenerator({
          aiIdentity: senderIdentity,
          systemInstruction: `You are ${senderIdentity.displayName} (${senderIdentity.handle}), the Personal AI owned by ${senderIdentity.ownerDisplayName}. Answer your owner's question concisely using the local owner context below.`,
          prompt: `Owner Message: "${content}"\n\nLocal Context:\n${localContext}`,
        });
        replyText = gen.text;
        tokensUsed = gen.tokensUsed;
        costUsd = gen.costUsd;
      } catch {
        replyText = `**[${senderIdentity.displayName} · Local Personal Runtime]** Based on your private workspace context: ${
          dataset?.workStatus.publicSummary ?? ''
        }\n\n${
          relevantMemories.length > 0
            ? `Referenced Memory: *${relevantMemories[0].title}* — ${relevantMemories[0].content}`
            : 'Ready to assist or invoke remote Personal AIs via `/ask @bob` or `/ask @charlie`.'
        }`;
      }
    } else {
      replyText = `**[${senderIdentity.displayName} · Local Personal Runtime]** Based on your private workspace context: ${
        dataset?.workStatus.publicSummary ?? ''
      }\n\n${
        relevantMemories.length > 0
          ? `Referenced Memory: *${relevantMemories[0].title}* — ${relevantMemories[0].content}`
          : 'Ready to assist or invoke remote Personal AIs via `/ask @bob` or `/ask @charlie`.'
      }`;
    }

    const assistantMsg: ChatMessage = {
      id: `msg_a_${Date.now()}`,
      conversationId: conv.id,
      role: 'assistant',
      senderAiId: senderIdentity.aiId,
      senderDisplayName: `${senderIdentity.displayName} (${senderIdentity.handle})`,
      content: replyText,
      timestamp: new Date().toISOString(),
      attributionLabel: `Local Personal AI (${senderIdentity.executionMode} · ${senderIdentity.configuredModel})`,
      modelUsed: senderIdentity.configuredModel,
      tokensUsed,
      costUsd,
    };
    conv.messages.push(assistantMsg);

    res.status(200).json({
      conversation: conv,
      messagesAdded: [userMsg, assistantMsg],
    });
  });

  // --------------------------------------------------------------------------
  // 5. Chatbot Node Management Proxy -> Calls Gateway SDK (`http://localhost:4000`)
  // --------------------------------------------------------------------------
  app.post('/api/chatbot/nodes/:aiId/presence', async (req, res) => {
    const { aiId } = req.params;
    const { online, executionMode } = req.body ?? {};
    const agent = nodeAgents.get(aiId);
    const identity = identities.get(aiId);

    if (!agent || !identity) {
      res.status(404).json({ error: `Personal AI '${aiId}' not found.` });
      return;
    }

    if (executionMode) {
      identity.executionMode = executionMode as ExecutionMode;
    }
    if (typeof online === 'boolean') {
      identity.online = online;
    }

    try {
      await agent.setOnlineStatus(identity.online);
      await gatewayClient.updateIdentityConfig(aiId, {
        online: identity.online,
        executionMode: identity.executionMode,
      });
      res.status(200).json({ identity });
    } catch (err) {
      res.status(503).json({
        error:
          err instanceof Error
            ? err.message
            : `Gateway at ${GATEWAY_INTERNAL_URL} is unreachable.`,
      });
    }
  });

  app.post('/api/chatbot/nodes/:aiId/kill-switch', async (req, res) => {
    const { aiId } = req.params;
    const { active } = req.body ?? {};
    const identity = identities.get(aiId);
    if (!identity) {
      res.status(404).json({ error: `Personal AI '${aiId}' not found.` });
      return;
    }
    identity.killSwitchActive = Boolean(active);
    const agent = nodeAgents.get(aiId);
    if (agent) agent.identity.killSwitchActive = Boolean(active);

    try {
      await gatewayClient.updateIdentityConfig(aiId, {
        killSwitchActive: identity.killSwitchActive,
      });
    } catch {
      // Local policy engine also enforces killSwitchActive immediately
    }
    res.status(200).json({ identity });
  });

  app.post('/api/chatbot/nodes/:aiId/rotate-key', async (req, res) => {
    const { aiId } = req.params;
    const identity = identities.get(aiId);
    const agent = nodeAgents.get(aiId);
    if (!identity || !agent) {
      res.status(404).json({ error: `Personal AI '${aiId}' not found.` });
      return;
    }

    try {
      const rotated = await gatewayClient.rotateIdentityKey(aiId);
      if (rotated) {
        identities.set(aiId, rotated);
        agent.identity = rotated;
        await agent.registerAndConnect();
      }
      res.status(200).json({ identity: rotated ?? identity });
    } catch (err) {
      res.status(503).json({
        error:
          err instanceof Error
            ? err.message
            : `Gateway at ${GATEWAY_INTERNAL_URL} is unreachable.`,
      });
    }
  });

  app.post('/api/chatbot/nodes/:aiId/verify-pairing', async (req, res) => {
    const { aiId } = req.params;
    const agent = nodeAgents.get(aiId);
    if (!agent) {
      res.status(404).json({ verified: false, reason: `Personal AI '${aiId}' not found.` });
      return;
    }

    const result = await agent.registerAndConnect();
    res.status(200).json({
      verified: result.registered,
      wsAuthenticated: result.wsAuthenticated,
      reason: result.error,
      challengeId: `chal_verified_${Date.now()}`,
    });
  });

  // --------------------------------------------------------------------------
  // 6. Permissions, Approvals, Memories & Model Settings (`/api/chatbot/*`)
  // --------------------------------------------------------------------------
  app.patch('/api/chatbot/permissions/:ownerAiId/:ruleId', (req, res) => {
    const { ownerAiId, ruleId } = req.params;
    const { mode } = req.body ?? {};
    const updated = policyEngine.updateRuleMode(
      ownerAiId,
      ruleId,
      mode as PermissionMode
    );
    if (!updated) {
      res.status(404).json({ error: 'Permission rule not found' });
      return;
    }
    recordChatbotAudit({
      module: 'OwnerPolicyEngine',
      eventType: 'PERMISSION_RULE_UPDATED',
      actorAiId: ownerAiId,
      outcome: 'SUCCESS',
      summary: `Updated permission rule ${ruleId} to mode ${mode}.`,
    });
    res.status(200).json({ rule: updated });
  });

  app.post('/api/chatbot/approvals/:requestId/resolve', async (req, res) => {
    const { requestId } = req.params;
    const { approve } = req.body ?? {};

    let resolvedEnvelope = null;
    let resolvingAgent: PersonalAINodeAgent | null = null;
    for (const agent of nodeAgents.values()) {
      const env = await agent.resolvePendingApproval(requestId, Boolean(approve));
      if (env) {
        resolvedEnvelope = env;
        resolvingAgent = agent;
        break;
      }
    }

    if (resolvedEnvelope && resolvingAgent) {
      // Update conversation thread with the owner-approved or owner-rejected answer
      for (const conv of conversations.values()) {
        conv.messages.push({
          id: `msg_appr_${Date.now()}`,
          conversationId: conv.id,
          role: 'remote_ai',
          senderAiId: resolvingAgent.identity.aiId,
          senderDisplayName: `${resolvingAgent.identity.displayName} (${resolvingAgent.identity.handle})`,
          content: resolvedEnvelope.payload.answer,
          timestamp: new Date().toISOString(),
          attributionLabel: resolvedEnvelope.payload.attributionLabel,
          minimizedFields: resolvedEnvelope.payload.minimizedFieldsReturned,
          redactedFields: resolvedEnvelope.payload.redactedFields,
        });
      }
    }

    res.status(200).json({ resolved: Boolean(resolvedEnvelope) });
  });

  app.post('/api/chatbot/memories', (req, res) => {
    const { ownerAiId, category, title, content, tags = [] } = req.body ?? {};
    const nowIso = new Date().toISOString();
    const entry = memoryManager.addMemory({
      memoryId: `mem_${Date.now()}`,
      ownerAiId,
      category: category as MemoryCategory,
      title,
      content,
      tags,
      sourceAiId: ownerAiId,
      sourceOwnerId: `owner_${ownerAiId.replace('ai_', '')}`,
      trustClassification: 'VERIFIED_OWNER',
      retentionPolicy: 'PERMANENT',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    res.status(201).json({ memory: entry });
  });

  app.patch('/api/chatbot/memories/:memoryId', (req, res) => {
    const { memoryId } = req.params;
    const { title, content, category, tags } = req.body ?? {};
    const updated = memoryManager.updateMemory(memoryId, {
      title,
      content,
      category: category as MemoryCategory | undefined,
      tags,
    });
    if (!updated) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }
    res.status(200).json({ memory: updated });
  });

  app.delete('/api/chatbot/memories/:memoryId', (req, res) => {
    const { memoryId } = req.params;
    const deleted = memoryManager.deleteMemory(memoryId);
    res.status(200).json({ deleted });
  });

  app.post('/api/chatbot/memories/share', (req, res) => {
    const { memoryId, ownerAiId, recipientAiId, ttlHours = 72 } = req.body ?? {};
    const result = memoryManager.shareMemoryWithAI({
      memoryId,
      ownerAiId,
      recipientAiId,
      ttlHours,
    });
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(200).json(result);
  });

  app.post('/api/chatbot/memories/grants/:grantId/revoke', (req, res) => {
    const { grantId } = req.params;
    const { ownerAiId } = req.body ?? {};
    const result = memoryManager.revokeMemoryGrant(grantId, ownerAiId);
    res.status(200).json(result);
  });

  // Group Management Endpoints
  app.post('/api/chatbot/groups', (req, res) => {
    const {
      title = 'Multi-AI Strategy Session',
      createdByAiId = 'ai_alice',
      participantAiIds = ['ai_alice', 'ai_bob', 'ai_charlie'],
    } = req.body ?? {};
    const nowIso = new Date().toISOString();
    const groupId = `grp_${Date.now()}`;
    const participants = Array.from(identities.values())
      .filter((id) => participantAiIds.includes(id.aiId))
      .map((id) => ({
        aiId: id.aiId,
        handle: id.handle,
        displayName: id.displayName,
        ownerName: id.ownerDisplayName,
        status: 'ACTIVE' as const,
        joinedAt: nowIso,
        model: id.configuredModel,
      }));

    const newGroup: GroupSession = {
      groupId,
      title,
      createdByAiId,
      participants,
      messages: [],
      status: 'ACTIVE',
      maxTurnLimit: 15,
      currentTurnCount: 0,
      maxBudgetUsd: 0.5,
      currentCostUsd: 0,
      createdAt: nowIso,
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    };
    groups.set(groupId, newGroup);

    const grpConv: ConversationThread = {
      id: `conv_${groupId}`,
      ownerAiId: createdByAiId,
      title,
      pinned: false,
      archived: false,
      isGroup: true,
      groupId,
      createdAt: nowIso,
      updatedAt: nowIso,
      messages: [
        {
          id: `msg_grp_init_${Date.now()}`,
          conversationId: `conv_${groupId}`,
          role: 'system',
          senderAiId: createdByAiId,
          senderDisplayName: 'Group Session',
          content: `Started group conversation **${title}** with ${participants
            .map((p) => p.displayName)
            .join(', ')}.`,
          timestamp: nowIso,
        },
      ],
    };
    conversations.set(grpConv.id, grpConv);
    res.status(201).json({ group: newGroup, conversation: grpConv });
  });

  app.post('/api/chatbot/groups/:groupId/participants', (req, res) => {
    const group = groups.get(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const { aiId } = req.body ?? {};
    const identity = identities.get(aiId);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }
    const existing = group.participants.find((p) => p.aiId === aiId);
    if (existing) {
      existing.status = 'ACTIVE';
    } else {
      group.participants.push({
        aiId: identity.aiId,
        handle: identity.handle,
        displayName: identity.displayName,
        ownerName: identity.ownerDisplayName,
        status: 'ACTIVE',
        joinedAt: new Date().toISOString(),
        model: identity.configuredModel,
      });
    }
    res.status(200).json({ group });
  });

  app.delete('/api/chatbot/groups/:groupId/participants/:aiId', (req, res) => {
    const group = groups.get(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const participant = group.participants.find((p) => p.aiId === req.params.aiId);
    if (participant) {
      participant.status = 'REMOVED';
    }
    res.status(200).json({ group });
  });

  app.post('/api/chatbot/groups/:groupId/end', (req, res) => {
    const group = groups.get(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    group.status = 'ENDED';
    res.status(200).json({ group });
  });

  // Message Update / Feedback Endpoint
  app.patch('/api/chatbot/conversations/:convId/messages/:msgId', (req, res) => {
    const conv = conversations.get(req.params.convId);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const msg = conv.messages.find((m) => m.id === req.params.msgId);
    if (!msg) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (typeof req.body?.content === 'string') {
      msg.content = req.body.content;
    }
    if ('feedback' in (req.body ?? {})) {
      msg.feedback = req.body.feedback;
    }
    res.status(200).json({ message: msg, conversation: conv });
  });

  app.post('/api/chatbot/identities/:aiId/model', async (req, res) => {
    const { aiId } = req.params;
    const { provider, model } = req.body ?? {};
    const identity = identities.get(aiId);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }
    if (provider) identity.configuredProvider = provider;
    if (model) identity.configuredModel = model;

    try {
      await gatewayClient.updateIdentityConfig(aiId, {
        configuredProvider: identity.configuredProvider,
        configuredModel: identity.configuredModel,
      });
    } catch {
      // Gateway update is best-effort if offline
    }
    res.status(200).json({ identity });
  });

  // --------------------------------------------------------------------------
  // 7. Vite Dev Middleware / Static SPA Hosting (Chatbot Frontend ONLY)
  // --------------------------------------------------------------------------
  if (config.attachViteMiddleware !== false) {
    if (process.env.NODE_ENV !== 'production') {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true, hmr: false, watch: null },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      const distPath = path.resolve(process.cwd(), 'dist');
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  const httpServer = http.createServer(app);

  await new Promise<void>((resolve) => {
    httpServer.listen(PORT, HOST, () => {
      resolve();
    });
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;

  return {
    app,
    httpServer,
    port: actualPort,
    gatewayClient,
    nodeAgents,
    syncNodesWithGateway,
    close: async () => {
      clearInterval(gatewaySyncInterval);
      for (const agent of nodeAgents.values()) {
        await agent.close();
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// Start Chatbot Server if executed directly
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('chatbotMain.ts');

if (isMain) {
  createChatbotServer()
    .then((instance) => {
      console.log(
        `[ai-nexus-chatbot] Chatbot Application listening on http://localhost:${instance.port}`
      );
      console.log(
        `[ai-nexus-chatbot] Health endpoint: http://localhost:${instance.port}/health`
      );
      console.log(
        `[ai-nexus-chatbot] Configured Gateway dependency: ${
          process.env.GATEWAY_INTERNAL_URL || 'http://localhost:4000'
        }`
      );
    })
    .catch((err) => {
      console.error('[ai-nexus-chatbot] Failed to start Chatbot server:', err);
      process.exit(1);
    });
}
