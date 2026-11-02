# AI Nexus Gateway (`ai-nexus-gateway`)

Independent communication infrastructure for Personal AI nodes.

## Development & Runtime
- **Entrypoint**: `src/server/gatewayMain.ts`
- **HTTP Base URL**: `http://localhost:4000`
- **WebSocket Transport**: `ws://localhost:4000/ws/node`
- **Health Checks**: `GET http://localhost:4000/health` and `GET http://localhost:4000/ready`

## Commands
```bash
npm install
npm run dev
npm test
```

## Architectural Guarantees
- Zero imports from `ai-nexus-chatbot`
- Zero React frontend hosting
- Zero LLM provider initialization
- Zero private key or private user memory storage
