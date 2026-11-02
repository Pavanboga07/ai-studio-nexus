// ============================================================================
// Phase 0 Architecture Blueprint, Repository Separation & Requirements Matrix
// ============================================================================

export interface ArchitectureDiagramSpec {
  id: string;
  number: string;
  title: string;
  summary: string;
  mermaidCode: string;
  keyInvariants: string[];
}

export interface RequirementRow {
  reqId: string;
  category: string;
  description: string;
  repository: 'ai-nexus-chatbot' | 'ai-nexus-gateway' | 'ai-nexus-protocol';
  module: string;
  status: 'VERIFIED' | 'ACTIVE';
  testCoverage: string;
  knownLimitations: string;
}

export const ARCHITECTURE_DIAGRAMS: ArchitectureDiagramSpec[] = [
  {
    id: 'high-level',
    number: '01',
    title: 'High-Level Product & Network Architecture',
    summary:
      'Independent Personal AI runtimes communicate through the zero-knowledge AI Nexus Gateway without sharing private databases, keys, or unshared memory.',
    mermaidCode: `flowchart TB
  subgraph AliceNode["Alice's Personal AI Runtime (ai-nexus-chatbot)"]
    AUI["ChatGPT-Style UI & Composer"]
    AOrch["PersonalAIOrchestrator"]
    APol["OwnerPolicyEngine (Alice)"]
    AMem["MemoryManager (4 Categories)"]
    ALLM["LLM Provider Adapter (Gemini / OpenAI / Anthropic / Local)"]
  end

  subgraph Gateway["AI Nexus Gateway (ai-nexus-gateway)"]
    GAuth["Ed25519 Auth & Replay Guard"]
    GRoute["MessageRouter & Invocation State Machine"]
    GQueue["OfflineQueueManager & GroupSessionTransport"]
    GAudit["AuditService & RateLimiter"]
  end

  subgraph BobNode["Bob's Personal AI Runtime (VPS / Hybrid Node)"]
    BPol["Deterministic OwnerPolicyEngine (Bob)"]
    BMin["Field-Level Data Minimizer"]
    BMem["Bob Isolated Memory Vault"]
    BLLM["Bob Configured LLM Adapter"]
  end

  AUI --> AOrch
  AOrch --> ALLM
  AOrch --> AMem
  AOrch <==>|"HTTPS REST + WSS Protocol v1.0"| GAuth
  GAuth --> GRoute
  GRoute --> GQueue
  GRoute <==>|"Signed Envelope (WSS)"| BPol
  BPol --> BMin
  BMin --> BMem
  BMin --> BLLM`,
    keyInvariants: [
      'Gateway transports authenticated envelopes only; it never executes LLM prompts or stores private user memories.',
      'Every Personal AI retains its own cryptographic Ed25519 identity keypair on its owner-controlled runtime.',
      'All incoming remote requests pass through the recipient’s deterministic OwnerPolicyEngine before any context is assembled.',
    ],
  },
  {
    id: 'repo-separation',
    number: '02',
    title: 'Strict Two-Repository Separation & Versioned Protocol Contract',
    summary:
      'Complete Git and build isolation between Repository A (ai-nexus-chatbot) and Repository B (ai-nexus-gateway), connected exclusively via ai-nexus-protocol v1.0.',
    mermaidCode: `flowchart LR
  RepoA["Repository A: ai-nexus-chatbot\n(User UI, Personal AI Engine, Memory, Policy Engine)"]
  Proto["Package: ai-nexus-protocol v1.0\n(Typed Envelopes, State Machine, Error Codes, SDK)"]
  RepoB["Repository B: ai-nexus-gateway\n(Identity Registry, Pairing, WSS Router, Offline Queue)"]

  RepoA -->|"Consumes public SDK & schemas"| Proto
  RepoB -->|"Validates public envelopes & schemas"| Proto
  RepoA <-->|"HTTPS /api/gateway/v1/* + WSS /ws/gateway"| RepoB`,
    keyInvariants: [
      'Zero shared application source folders or cross-repository internal imports.',
      'Both repositories clone, install, build, test, and deploy independently.',
      'Chatbot supports a MockGatewayAdapter for offline local UI development and real Gateway transport in production.',
    ],
  },
  {
    id: 'invocation-lifecycle',
    number: '05',
    title: 'AI-to-AI Remote Invocation Lifecycle & 13-State Machine',
    summary:
      'End-to-end execution of `/ask @bob What is your availability tomorrow?` from command parsing to minimized response attribution.',
    mermaidCode: `sequenceDiagram
  autonumber
  actor Alice as Alice (Owner)
  participant AliceAI as Alice AI (@alice)
  participant GW as AI Nexus Gateway
  participant BobPol as Bob Policy Engine
  participant BobAI as Bob AI (@bob)

  Alice->>AliceAI: /ask @bob What is your availability tomorrow?
  AliceAI->>AliceAI: Parse command -> capability: calendar.availability
  AliceAI->>GW: Signed Envelope (CREATED -> SENT)
  GW->>GW: Verify Ed25519 sig, nonce, rate limit, recipient status
  GW->>BobPol: Deliver over WSS (RECEIVED -> AUTHENTICATED)
  BobPol->>BobPol: Check Rule perm_bob_cal_alice (ALLOW_AUTOMATICALLY)
  BobPol->>BobAI: Apply Data Minimization (Free/Busy ONLY, strip titles)
  BobAI->>BobAI: Generate answer via Bob's LLM (EXECUTING -> RESPONDING)
  BobAI->>GW: Signed Response Envelope
  GW->>AliceAI: Deliver correlated response (COMPLETED)
  AliceAI->>Alice: Render "According to Bob's AI (@bob): 2:00 PM - 4:00 PM PST"`,
    keyInvariants: [
      'State machine enforces deterministic transitions: CREATED -> SENT -> RECEIVED -> AUTHENTICATED -> AUTHORIZED -> EXECUTING -> RESPONDING -> COMPLETED.',
      'Terminal/exceptional states (REJECTED, FAILED, EXPIRED, CANCELLED, REQUIRES_APPROVAL) prevent ambiguous delivery vs. completion states.',
      'Remote answers are stored in `external_ai` memory with explicit source attribution, never as unqualified `owner_private` facts.',
    ],
  },
  {
    id: 'security-boundaries',
    number: '12',
    title: 'Zero-Trust Data-Flow & Prompt Injection Defense Boundaries',
    summary:
      'Deterministic policy evaluation, field-level redaction, and untrusted input sanitization prevent prompt injection and privilege escalation.',
    mermaidCode: `flowchart LR
  Ext["Incoming External AI Envelope\n(Untrusted Input)"] --> Sig["1. Ed25519 Signature & Nonce Check"]
  Sig --> Inj["2. Deterministic PromptInjectionGuard\n(Blocks system override / key export)"]
  Inj --> Pol["3. Deterministic OwnerPolicyEngine\n(ALLOW_AUTOMATICALLY | REQUIRE_APPROVAL | DENY)"]
  Pol --> Min["4. Field-Level Data Minimization\n(Strip titles, attendees, private notes)"]
  Min --> SafeLLM["5. Sandboxed LLM Context\n(Read-Only Minimized Data Only)"]`,
    keyInvariants: [
      'PromptInjectionGuard runs deterministically in TypeScript before any LLM prompt is constructed.',
      'No LLM call can modify permission grants, access unshared `owner_private` memories, or invoke unauthorized tools.',
      'Private Ed25519 keys never leave the owner-controlled runtime node.',
    ],
  },
];

export const REQUIREMENTS_MATRIX: RequirementRow[] = [
  {
    reqId: 'REQ-ARCH-01',
    category: 'Repository Separation',
    description: 'Two completely independent Git repositories (ai-nexus-chatbot and ai-nexus-gateway) plus versioned ai-nexus-protocol contract.',
    repository: 'ai-nexus-protocol',
    module: 'Protocol & Repo Boundaries',
    status: 'VERIFIED',
    testCoverage: 'nexus.test.ts + standalone repo tests',
    knownLimitations: 'In the single-container AI Studio preview, both services are mounted on port 3000 while standalone Git repos reside in /repositories/*.',
  },
  {
    reqId: 'REQ-GW-01',
    category: 'Cryptographic Identity & Pairing',
    description: 'Ed25519 public key registration, short-lived challenge-response proof of possession, key rotation, and identity revocation.',
    repository: 'ai-nexus-gateway',
    module: 'IdentityRegistry / PairingService',
    status: 'VERIFIED',
    testCoverage: 'Gateway PairingService unit & replay test',
    knownLimitations: 'Private keys remain strictly on the client/runtime node.',
  },
  {
    reqId: 'REQ-GW-02',
    category: 'Envelope Routing, Replay & Offline Queue',
    description: 'Validate protocol version, TTL expiry, nonce uniqueness, idempotencyKey deduplication, rate limits, and offline queueing.',
    repository: 'ai-nexus-gateway',
    module: 'MessageRouter / OfflineQueueManager',
    status: 'VERIFIED',
    testCoverage: 'Offline queue & idempotency E2E test',
    knownLimitations: 'In-memory store in preview container; PostgreSQL schema migrations provided in db/schema.sql.',
  },
  {
    reqId: 'REQ-CHAT-01',
    category: 'ChatGPT-Style UI & Command Composer',
    description: 'Collapsible sidebar, conversation management, slash commands (/ask, /ask-all, /group, /share-memory), and natural-language AI-to-AI intent routing.',
    repository: 'ai-nexus-chatbot',
    module: 'CommandParser / ChatWorkspace',
    status: 'VERIFIED',
    testCoverage: 'CommandParser unit test + Playwright UI verification',
    knownLimitations: 'None.',
  },
  {
    reqId: 'REQ-POL-01',
    category: 'Deterministic Permission Engine & Data Minimization',
    description: 'Enforce ALLOW_AUTOMATICALLY, REQUIRE_APPROVAL, and DENY per sender & capability, stripping private meeting titles and notes.',
    repository: 'ai-nexus-chatbot',
    module: 'OwnerPolicyEngine / PromptInjectionGuard',
    status: 'VERIFIED',
    testCoverage: 'Data minimization, revocation & prompt injection E2E tests',
    knownLimitations: 'None.',
  },
  {
    reqId: 'REQ-MEM-01',
    category: 'Four-Category Memory Vault & Revocable Sharing',
    description: 'Isolate owner_private, external_ai, shared_context, and system_knowledge; enforce explicit read-only grants and revocation disclosures.',
    repository: 'ai-nexus-chatbot',
    module: 'MemoryManager',
    status: 'VERIFIED',
    testCoverage: 'Cross-user memory sharing & revocation test',
    knownLimitations: 'Includes explicit user disclosure that revocation cannot force-erase data already copied outside platform storage.',
  },
  {
    reqId: 'REQ-GRP-01',
    category: 'Multi-AI Group Sessions & Autonomous Follow-Ups',
    description: 'Shared group context for @alice, @bob, and @charlie with turn coordination, 5-turn follow-up ceiling, budget cap, and loop detection.',
    repository: 'ai-nexus-chatbot',
    module: 'GroupConversationManager / AutonomousFollowUpEngine',
    status: 'VERIFIED',
    testCoverage: 'Group broadcast & loop detection unit tests',
    knownLimitations: 'None.',
  },
];
