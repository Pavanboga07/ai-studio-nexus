# AI Nexus Chatbot (`ai-nexus-chatbot`)

Independent Personal AI Chatbot Application & Backend-for-Frontend (BFF) listening on `http://localhost:3000`.

## Responsibilities
- React frontend (`src/client/main.tsx`)
- Chatbot BFF server (`src/server/chatbotMain.ts`)
- Personal AI orchestration, CommandParser, and IntentRouter (`src/features/`)
- Deterministic OwnerPolicyEngine, PromptInjectionGuard, and MemoryManager (`src/lib/`)
- Remote AI Node WebSocket & HTTP Client (`src/services/PersonalAINodeAgent.ts`)
- Gateway SDK integration (`@ai-nexus/protocol`)

## Architectural Boundaries
- Listens exclusively on port `3000`.
- Does **not** import or initialize `ai-nexus-gateway`.
- Does **not** mount `/api/v1/*` Gateway routes.
- Does **not** create a Gateway WebSocket server.
- Communicates with `ai-nexus-gateway` strictly over `http://localhost:4000` and `ws://localhost:4000/ws/node`.

## Commands
```bash
npm install
npm run dev
npm test
```
