# AI NEXUS — SYSTEM ARCHITECTURE & PHASE 0 SPECIFICATION

## 1. Executive Architecture Overview

**AI Nexus** is a Personal AI platform with native, cryptographically authenticated AI-to-AI communication. Every user owns an independent Personal AI (`@alice`, `@bob`, `@charlie`) with its own cryptographic identity, private memory vault, configured LLM provider/model, and deterministic permission policy engine.

The system is architected around **two strictly separated Git repositories** communicating exclusively over the versioned **AI Nexus Protocol v1.0** (`ai-nexus-protocol`):
1. **Repository A (`ai-nexus-chatbot`)**: The user-facing ChatGPT-style web application and Personal AI runtime orchestrator.
2. **Repository B (`ai-nexus-gateway`)**: The zero-knowledge communication transport infrastructure that authenticates nodes, validates message envelopes, prevents replay attacks, manages offline queues, and routes invocations without ever touching private keys, LLM execution, or private user memories.

---

## 2. Architecture Diagrams (Mermaid)

### 2.1 High-Level Product Architecture & Trust Boundaries
```mermaid
flowchart TB
  User["Human Owner (Alice)"] --> ChatUI["AI Nexus Chatbot UI"]
  subgraph ChatbotRepo["Repository A: ai-nexus-chatbot"]
    ChatUI --> ConvMgr["ConversationManager"]
    ConvMgr --> Orch["PersonalAIOrchestrator"]
    Orch --> LLMAdapter["LLMProviderRegistry (Gemini / OpenAI / Anthropic / Local)"]
    Orch --> MemMgr["MemoryManager (4 Categories)"]
    Orch --> PolClient["OwnerPolicyEngine & PermissionClient"]
    Orch --> RemClient["RemoteAIClient (Protocol v1.0 SDK)"]
  end

  RemClient <==>|"HTTPS /api/gateway/v1 + WSS /ws/gateway"| GWAuth

  subgraph GatewayRepo["Repository B: ai-nexus-gateway"]
    GWAuth["AuthenticationService & ReplayProtection"] --> GWRouter["MessageRouter & InvocationManager"]
    GWRouter --> GWQueue["OfflineQueueManager"]
    GWRouter --> GWGroup["GroupSessionTransport"]
    GWRouter --> GWAudit["AuditService & RateLimiter"]
  end

  GWRouter <==>|"Signed Envelope (WSS)"| BobRuntime["Bob's Personal AI Runtime (Local / VPS / Cloud)"]
```

### 2.2 AI-to-AI Remote Invocation Lifecycle (`CREATED` → `COMPLETED`)
```mermaid
sequenceDiagram
  autonumber
  actor Alice as Alice
  participant AliceAI as Alice AI (@alice)
  participant GW as AI Nexus Gateway
  participant BobPol as Bob OwnerPolicyEngine
  participant BobAI as Bob AI (@bob)

  Alice->>AliceAI: /ask @bob What is your availability tomorrow?
  AliceAI->>AliceAI: CommandParser -> capability: calendar.availability
  AliceAI->>GW: Signed Envelope (CREATED -> SENT)
  GW->>GW: Verify Ed25519 signature, nonce, TTL, rate limit
  GW->>BobPol: Deliver over WSS (RECEIVED -> AUTHENTICATED)
  BobPol->>BobPol: Evaluate Rule perm_bob_cal_alice (ALLOW_AUTOMATICALLY)
  BobPol->>BobAI: Apply Data Minimization (Free/Busy ONLY; strip titles/attendees)
  BobAI->>BobAI: Execute LLM over minimized context (EXECUTING -> RESPONDING)
  BobAI->>GW: Signed Response Envelope
  GW->>AliceAI: Deliver correlated response (COMPLETED)
  AliceAI->>Alice: Display "According to Bob's AI (@bob): 2:00 PM - 4:00 PM PST"
```

### 2.3 Cryptographic Pairing & Proof-of-Possession Lifecycle
```mermaid
sequenceDiagram
  autonumber
  participant Node as Personal AI Runtime Node
  participant GW as AI Nexus Gateway (PairingService)

  Node->>Node: Generate Ed25519 Keypair (Private key stays in local secure store)
  Node->>GW: POST /api/gateway/v1/pairing/challenge (aiId, nodeId, publicKeyPem)
  GW-->>Node: Short-lived PairingChallenge (challengeId, nonce, expiresAt)
  Node->>Node: Sign (challengeId : nonce : aiId) with Ed25519 Private Key
  Node->>GW: POST /api/gateway/v1/pairing/verify (challengeId, signature)
  GW->>GW: Verify signature against publicKeyPem & consume nonce
  GW-->>Node: Identity VERIFIED & WSS session activated
```

### 2.4 Group AI Communication & Autonomous Follow-Up Loop Prevention
```mermaid
flowchart LR
  Prompt["/ask-all Review Q4 Proposal"] --> GroupMgr["GroupConversationManager"]
  GroupMgr --> GWGroup["Gateway GroupSessionTransport"]
  GWGroup --> AliceNode["@alice Runtime (Isolated Memory)"]
  GWGroup --> BobNode["@bob Runtime (Isolated Memory)"]
  GWGroup --> CharlieNode["@charlie Runtime (Isolated Memory)"]
  AliceNode & BobNode & CharlieNode --> LoopGuard["AutonomousFollowUpEngine\n(Max 5 Turns · $0.05 Cap · Cycle Detection)"]
```
