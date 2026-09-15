# Agent Authorization Firewall

This repository now contains the Phase 0 planning documents and the Phase 1 learning prototype scaffolding.

The project is a constrained authorization firewall for AI agents: a TypeScript/React/Fastify/PostgreSQL system that decides whether an agent action may execute, requires human approval for selected actions, and then dispatches work through a background worker with durable state and auditability. The paper’s narrow starting point is the refund workflow, and this plan keeps that as the first implementation slice.

## What to read first

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system boundaries and lifecycle.
2. [docs/DATA_AND_API_DESIGN.md](docs/DATA_AND_API_DESIGN.md) for the entities, states, and endpoints.
3. [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the dependency-ordered build phases and implementation status.
4. [docs/SECURITY_AND_TESTING.md](docs/SECURITY_AND_TESTING.md) for invariants and test coverage.
5. [docs/DECISIONS_AND_QUESTIONS.md](docs/DECISIONS_AND_QUESTIONS.md) for assumptions, tradeoffs, and blockers.
6. [docs/FILE_MAP.md](docs/FILE_MAP.md) for the proposed file structure and phase-by-phase file ownership.

## Initial scope

The MVP starts with the refund authorization flow described in the paper:

- A TypeScript SDK submits a refund action.
- Fastify validates the request, derives tenant identity server-side, and records an immutable action.
- The policy layer returns allow, deny, or require approval.
- A manager approves or rejects the exact request.
- A background worker performs execution with idempotency, reconciliation, and audit logging.

Phase 1 has been implemented with the shared contract and policy prototype. The project deliberately excludes broad tool coverage, public webhooks, MCP adapter work, pricing, and production hardening until the core refund flow is stable.

## Notes on the paper

The paper is treated as a concept and tutorial prototype, not as production-ready guidance. The planning documents below call out missing requirements, contradictions, and insecure assumptions before the later phases are implemented.# Agent Authorization Firewall

This repository is currently documentation-only. Implementation has not started.

The project is a constrained authorization firewall for AI agents: a TypeScript/React/Fastify/PostgreSQL system that decides whether an agent action may execute, requires human approval for selected actions, and then dispatches work through a background worker with durable state and auditability. The paper’s narrow starting point is the refund workflow, and this plan keeps that as the first implementation slice.

## What to read first

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system boundaries and lifecycle.
2. [docs/DATA_AND_API_DESIGN.md](docs/DATA_AND_API_DESIGN.md) for the entities, states, and endpoints.
3. [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the dependency-ordered build phases.
4. [docs/SECURITY_AND_TESTING.md](docs/SECURITY_AND_TESTING.md) for invariants and test coverage.
5. [docs/DECISIONS_AND_QUESTIONS.md](docs/DECISIONS_AND_QUESTIONS.md) for assumptions, tradeoffs, and blockers.
6. [docs/FILE_MAP.md](docs/FILE_MAP.md) for the proposed file structure and phase-by-phase file ownership.

## Initial scope

The MVP starts with the refund authorization flow described in the paper:

- A TypeScript SDK submits a refund action.
- Fastify validates the request, derives tenant identity server-side, and records an immutable action.
- The policy layer returns allow, deny, or require approval.
- A manager approves or rejects the exact request.
- A background worker performs execution with idempotency, reconciliation, and audit logging.

The project deliberately excludes broad tool coverage, public webhooks, MCP adapter work, pricing, and production hardening until the core refund flow is stable.

## Notes on the paper

The paper is treated as a concept and tutorial prototype, not as production-ready guidance. The planning documents below call out missing requirements, contradictions, and insecure assumptions before any code is written.
