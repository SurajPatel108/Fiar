# Agent Authorization Firewall

This repository contains the completed Phase 1 policy prototype and the completed Phase 2 authenticated gateway intake backed by PostgreSQL.

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

Phase 2 accepts authenticated refund actions, derives tenant and permissions from a development-only credential adapter, loads tenant-owned facts and a published policy, and transactionally records the action, audit decision, and either pending approval or outbox work. It does not execute refunds.

## Local Phase 2 startup

Prerequisites: Node.js with npm and Docker with Compose.

```sh
npm install
docker compose -f infra/compose/docker-compose.yml up -d postgres
FIAR_DATABASE_URL=postgresql://fiar:fiar@127.0.0.1:5432/fiar npm run db:setup
FIAR_RUNTIME_MODE=development \
FIAR_DATABASE_URL=postgresql://fiar:fiar@127.0.0.1:5432/fiar \
FIAR_DEV_CREDENTIALS_JSON='[{"token":"local-alpha-agent","principalId":"prn_demo_alpha_agent"}]' \
npm run dev:gateway
```

The example secret is supplied only through the local process environment and is not stored by the seed. Submit it in the `x-fiar-dev-credential` header. The development credential adapter refuses to start unless `FIAR_RUNTIME_MODE=development`; it is not a production authentication mechanism.

Run `npm run verify` to execute strict typechecking, Phase 1 regressions, and the real PostgreSQL Phase 2 integration suite. Integration tests create unique temporary databases and drop only those databases; they do not reset the seeded `fiar` database or delete Docker volumes.

Phase 3 approval-decision endpoints, the worker, provider integrations, SDK, and dashboard are intentionally not implemented yet.

## Notes on the paper

The paper is treated as a concept and tutorial prototype, not as production-ready guidance. The planning documents call out missing requirements, contradictions, and insecure assumptions before later phases are implemented.
