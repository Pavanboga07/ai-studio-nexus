# AI Nexus Protocol (`@ai-nexus/protocol` v1.0.0)

Versioned public integration contract shared between the independently deployed `ai-nexus-chatbot` (port 3000) and `ai-nexus-gateway` (port 4000) repositories.

## Structure
- `src/types/` — Typed message envelopes, identity models, invocation states, permission rules, memory models, and error codes.
- `src/schemas/` — Deterministic envelope validation, state machine transition guards, and Ed25519 signature helpers.
- `src/events/` — WebSocket real-time protocol frame definitions (`/ws/node`).
- `src/sdk/` — `GatewayHttpClient` and `GatewayNodeWsClient` for communicating with `ai-nexus-gateway` over HTTP and WebSocket.
