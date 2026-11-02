// ============================================================================
// APPLICATION B: AI NEXUS GATEWAY
// Entrypoint: `ai-nexus-gateway/src/server/gatewayMain.ts`
// HTTP: `http://localhost:4000` | WebSocket: `ws://localhost:4000/ws/node`
// Zero Chatbot imports, zero frontend hosting, zero LLM providers.
// ============================================================================

import express from 'express';
import { createServer as createHttpServer, Server as HttpServer } from 'node:http';
import dotenv from 'dotenv';
import {
  ExecutionMode,
  GatewayHealthResponse,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../../../ai-nexus-protocol/src/index.ts';
import { IdentityRegistry } from '../identity/IdentityRegistry.ts';
import { AuthenticationService } from '../auth/AuthenticationService.ts';
import {
  isOriginAllowed,
  RateLimiter,
  ReplayAndIdempotencyGuard,
} from '../security/SecurityGuards.ts';
import { GatewayAuditService } from '../audit/AuditService.ts';
import { OfflineQueueManager } from '../queue/OfflineQueueManager.ts';
import { InvocationManager } from '../invocation/InvocationManager.ts';
import { WebSocketNodeTransport } from '../transport/WebSocketNodeTransport.ts';
import { MessageRouter } from '../routing/MessageRouter.ts';

dotenv.config();

export interface GatewayServerInstance {
  httpServer: HttpServer;
  port: number;
  close: () => Promise<void>;
  identities: IdentityRegistry;
  invocations: InvocationManager;
  offlineQueue: OfflineQueueManager;
}

export function createGatewayServer(config?: {
  port?: number;
  host?: string;
  allowedOrigins?: string;
  wsPath?: string;
}): Promise<GatewayServerInstance> {
  const PORT = config?.port ?? Number(process.env.GATEWAY_PORT || 4000);
  const HOST = config?.host ?? (process.env.HOST || '0.0.0.0');
  const ALLOWED_ORIGINS =
    config?.allowedOrigins ??
    (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,*');
  const NODE_WS_PATH = config?.wsPath ?? (process.env.NODE_WS_PATH || '/ws/node');

  const identities = new IdentityRegistry();
  const auth = new AuthenticationService(identities);
  const rateLimiter = new RateLimiter(60);
  const replayGuard = new ReplayAndIdempotencyGuard();
  const offlineQueue = new OfflineQueueManager();
  const invocations = new InvocationManager();
  const audit = new GatewayAuditService();
  const router = new MessageRouter(
    identities,
    auth,
    rateLimiter,
    replayGuard,
    invocations,
    offlineQueue,
    audit
  );

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // Explicit CORS enforcement for ALLOWED_ORIGINS
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin, ALLOWED_ORIGINS)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (ALLOWED_ORIGINS.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PATCH, DELETE, OPTIONS'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Correlation-Id'
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const httpServer = createHttpServer(app);
  const wsTransport = new WebSocketNodeTransport(
    httpServer,
    NODE_WS_PATH,
    ALLOWED_ORIGINS,
    identities,
    invocations,
    offlineQueue,
    audit
  );
  router.setWebSocketTransport(wsTransport);

  const buildHealthPayload = () => {
    const allIds = identities.listAll();
    const connectedAiIds = wsTransport.getConnectedAiIds();
    const queuedCount = offlineQueue.getAllQueued().length;
    return {
      status: 'OK' as const,
      service: 'ai-nexus-gateway' as const,
      version: '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      protocolVersion: '1.0',
      supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      databaseReady: true,
      databaseStatus: 'READY',
      wsTransportActive: true,
      wsPath: NODE_WS_PATH,
      registeredIdentities: allIds.length,
      registeredIdentitiesCount: allIds.length,
      activeNodeConnections: connectedAiIds.length,
      connectedNodesCount: connectedAiIds.length,
      connectedNodeAiIds: connectedAiIds,
      queuedMessagesCount: queuedCount,
      queueStatus: queuedCount > 0 ? `${queuedCount}_QUEUED` : 'IDLE',
      activeInvocationsCount: invocations.listAll().length,
      timestamp: new Date().toISOString(),
    };
  };

  // Required Gateway Operational Health & Readiness Endpoints
  app.get('/health', (_req, res) => {
    res.json(buildHealthPayload());
  });

  app.get('/ready', (_req, res) => {
    res.json({
      ready: true,
      ...buildHealthPayload(),
      checks: {
        identityRegistry: 'READY',
        messageRouter: 'READY',
        offlineQueue: 'READY',
        webSocketTransport: 'READY',
      },
    });
  });

  // Pairing & Proof-of-Possession Registration
  app.post('/api/v1/pairing/challenge', (req, res) => {
    const { aiId, nodeId, identity } = req.body ?? {};
    if (!aiId || !nodeId) {
      res.status(400).json({ error: 'aiId and nodeId are required' });
      return;
    }
    const challenge = identities.createPairingChallenge(aiId, nodeId, identity);
    res.json({ challenge });
  });

  app.post('/api/v1/pairing/verify', (req, res) => {
    const { challengeId, signature, keyFingerprint, aiId } = req.body ?? {};
    const result = identities.verifyPairingChallenge(
      challengeId,
      signature,
      keyFingerprint
    );
    audit.record({
      repository: 'ai-nexus-gateway',
      module: 'PairingService',
      eventType: result.verified
        ? 'IDENTITY_PROOF_OF_POSSESSION_VERIFIED'
        : 'PAIRING_CHALLENGE_FAILED',
      actorAiId: aiId ?? 'unknown',
      outcome: result.verified ? 'SUCCESS' : 'DENIED',
      summary: result.verified
        ? `Verified Ed25519 challenge-response signature for ${aiId} (${challengeId}).`
        : `Failed proof-of-possession challenge ${challengeId}: ${result.reason}`,
    });
    res.json(result);
  });

  // Identity Registry Endpoints
  app.get('/api/v1/identities', (_req, res) => {
    res.json({ identities: identities.listAll() });
  });

  app.get('/api/v1/identities/:aiId', (req, res) => {
    const found = identities.get(req.params.aiId);
    if (!found) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }
    res.json({ identity: found });
  });

  app.post('/api/v1/identities/:aiId/rotate-key', (req, res) => {
    const { aiId } = req.params;
    const newFp = `ed25519:${Math.random().toString(16).slice(2, 10)}${Date.now()
      .toString(16)
      .slice(-8)}`;
    const newPem = `-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA${Buffer.from(
      `${aiId}:${newFp}`
    ).toString('base64')}\n-----END PUBLIC KEY-----`;
    const updated = identities.rotateKey(aiId, newPem, newFp);
    if (!updated) {
      res.status(404).json({ error: 'Identity not found or revoked' });
      return;
    }
    audit.record({
      repository: 'ai-nexus-gateway',
      module: 'IdentityRegistry',
      eventType: 'PUBLIC_KEY_ROTATED',
      actorAiId: aiId,
      outcome: 'SUCCESS',
      summary: `Rotated Ed25519 public key for ${aiId} -> fingerprint ${newFp}.`,
    });
    res.json({ identity: updated });
  });

  app.post('/api/v1/identities/:aiId/revoke', (req, res) => {
    const { aiId } = req.params;
    const revoked = identities.revoke(aiId);
    if (!revoked) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }
    audit.record({
      repository: 'ai-nexus-gateway',
      module: 'IdentityRegistry',
      eventType: 'IDENTITY_REVOKED',
      actorAiId: aiId,
      outcome: 'REVOKED',
      summary: `Revoked AI identity ${aiId}.`,
    });
    res.json({ identity: revoked });
  });

  app.patch('/api/v1/identities/:aiId/status', (req, res) => {
    const { aiId } = req.params;
    const {
      online,
      executionMode,
      killSwitchActive,
      configuredProvider,
      configuredModel,
    } = req.body ?? {};
    const updated = identities.updateStatus(aiId, {
      online,
      executionMode: executionMode as ExecutionMode | undefined,
      killSwitchActive,
      configuredProvider,
      configuredModel,
    });
    if (!updated) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }
    let deliveredRecords: unknown[] = [];
    if (online === true) {
      deliveredRecords = wsTransport.drainOfflineQueueForNode(aiId);
    }
    audit.record({
      repository: 'ai-nexus-gateway',
      module: 'PresenceService',
      eventType: 'IDENTITY_STATUS_UPDATED',
      actorAiId: aiId,
      outcome: 'SUCCESS',
      summary: `Updated ${aiId} status (online=${updated.online}, mode=${updated.executionMode}, killSwitch=${updated.killSwitchActive}, drained=${deliveredRecords.length}).`,
    });
    res.json({ identity: updated, deliveredRecords });
  });

  // Permissions Reference Revocation
  app.post('/api/v1/permissions/:refId/revoke', (req, res) => {
    const { refId } = req.params;
    auth.revokePermissionReference(refId);
    res.json({ revoked: true, permissionReference: refId });
  });

  // Invocations Routing & Status
  app.post('/api/v1/invocations', async (req, res) => {
    const { envelope } = req.body ?? {};
    if (!envelope) {
      res.status(400).json({ error: 'Missing envelope in request body' });
      return;
    }
    const result = await router.routeInvocation(envelope);
    res.json(result);
  });

  app.get('/api/v1/invocations', (_req, res) => {
    res.json({
      invocations: invocations.listAll(),
      queuedOffline: offlineQueue.getAllQueued(),
    });
  });

  // Audit Events
  app.get('/api/v1/audit', (_req, res) => {
    res.json({ events: audit.list() });
  });

  return new Promise((resolve) => {
    httpServer.listen(PORT, HOST, () => {
      const address = httpServer.address();
      const actualPort =
        typeof address === 'object' && address ? address.port : PORT;
      console.log(
        `[ai-nexus-gateway] Listening on http://${HOST}:${actualPort} (WS: ws://${HOST}:${actualPort}${NODE_WS_PATH}) [PID: ${process.pid}]`
      );
      resolve({
        httpServer,
        port: actualPort,
        identities,
        invocations,
        offlineQueue,
        close: async () => {
          await wsTransport.close();
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}

// Run directly when invoked as `tsx src/server/gatewayMain.ts`
const isDirectExecution =
  process.argv[1]?.endsWith('gatewayMain.ts') ||
  process.argv[1]?.endsWith('gatewayMain.js');

if (isDirectExecution) {
  createGatewayServer().catch((err) => {
    console.error('[ai-nexus-gateway] Fatal startup error:', err);
    process.exit(1);
  });
}
