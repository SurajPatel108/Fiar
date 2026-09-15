# Agent Authorization Firewall

This repository contains the completed Phase 1 policy prototype, Phase 2 authenticated gateway intake, Phase 3 human approval API, Phase 4 controlled execution worker, and Phase 5 TypeScript SDK and local manager dashboard.

The implemented backend is a constrained authorization firewall for AI agents: a TypeScript/Fastify/PostgreSQL system that decides whether an agent action may execute, requires human approval for selected actions, and then dispatches work through a background worker with durable state and auditability. The paper’s narrow starting point is the refund workflow, and this plan keeps that as the first implementation slice.

## What to read first

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system boundaries and lifecycle.
2. [docs/DATA_AND_API_DESIGN.md](docs/DATA_AND_API_DESIGN.md) for the entities, states, and endpoints.
3. [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the dependency-ordered build phases and implementation status.
4. [docs/SECURITY_AND_TESTING.md](docs/SECURITY_AND_TESTING.md) for invariants and test coverage.
5. [docs/DECISIONS_AND_QUESTIONS.md](docs/DECISIONS_AND_QUESTIONS.md) for assumptions, tradeoffs, and blockers.
6. [docs/FILE_MAP.md](docs/FILE_MAP.md) for the proposed file structure and phase-by-phase file ownership.

## Initial scope

The MVP starts with the refund authorization flow described in the paper:

- An authenticated client submits a refund action to the gateway.
- Fastify validates the request, derives tenant identity server-side, and records an immutable action.
- The policy layer returns allow, deny, or require approval.
- A manager approves or rejects the exact request.
- A background worker performs execution with idempotency, reconciliation, and audit logging.

The gateway accepts authenticated refund actions and managers can resolve exact tenant-scoped approvals. The Phase 4 worker leases queued work, rechecks authorization, reserves capacity, and calls only a narrow provider connector. The default connector is a deterministic PostgreSQL-backed fake: it makes no network calls and moves no real money.

## Local Phase 5 startup

Prerequisites: Node.js with npm and Docker with Compose.

```sh
npm install
docker compose -f infra/compose/docker-compose.yml up -d postgres
FIAR_DATABASE_URL=postgresql://fiar:fiar@127.0.0.1:5432/fiar npm run db:setup
FIAR_RUNTIME_MODE=development \
FIAR_DATABASE_URL=postgresql://fiar:fiar@127.0.0.1:5432/fiar \
FIAR_DEV_CREDENTIALS_JSON='[{"token":"local-alpha-agent","principalId":"prn_demo_alpha_agent"},{"token":"local-alpha-manager","principalId":"prn_demo_alpha_manager"}]' \
npm run dev:gateway
```

In a second terminal, start the development worker:

```sh
FIAR_RUNTIME_MODE=development \
FIAR_DATABASE_URL=postgresql://fiar:fiar@127.0.0.1:5432/fiar \
npm run dev:worker
```

In a third terminal, start the manager dashboard:

```sh
npm run dev:dashboard
```

Open `http://127.0.0.1:5173`. Enter the configured local manager credential when prompted. Vite proxies the dashboard's `/v1` calls to the gateway, so no browser-only gateway route or weakened CORS/authentication path is required.

The example credentials are supplied only through the local process environment and are not stored by the seed. Submit the appropriate token in the `x-fiar-dev-credential` header. The development credential adapter refuses to start unless `FIAR_RUNTIME_MODE=development`; it is not a production authentication mechanism.

Applications can submit actions through the transport-only TypeScript client in `packages/sdk`; see [packages/sdk/README.md](packages/sdk/README.md). After creating an approval-required action, inspect and decide it in the dashboard. The equivalent raw HTTP decision remains:

```sh
curl -X POST http://127.0.0.1:3000/v1/approvals/APR_ID/decision \
  -H 'content-type: application/json' \
  -H 'x-fiar-dev-credential: local-alpha-manager' \
  -d '{"decision":"approve","comment":"Reviewed","expectedRequestHash":"SHA256_FROM_DETAIL","expectedPolicyVersion":"POLICY_ID_FROM_DETAIL"}'
```

The tenant execution kill switch is durable. This local administrative SQL enables it; set the boolean to `false` and clear the reason to disable it:

```sh
docker exec fiar-postgres psql -U fiar -d fiar -c \
  "update tenants set execution_kill_switch_enabled = true, execution_kill_switch_reason = 'local maintenance', execution_kill_switch_updated_at = now() where id = 'ten_demo_alpha';"
```

The switch prevents new provider calls. A call that crossed the connector boundary before the switch committed is still finalized or reconciled from its durable attempt; Fiar does not discard or guess its outcome.

Run `npm run verify` to execute strict typechecking, Phase 1 regressions, the Phase 2–3 gateway integration suite, the Phase 4 worker suite, SDK tests, and the dashboard typecheck/production build. Integration tests create unique temporary databases and drop only those databases; they do not reset the seeded `fiar` database or delete Docker volumes.

The SDK and dashboard are clients only: policy, identity, tenant scope, approval binding, execution, and reconciliation remain server-side. Production authentication/dashboard sessions, a real payment provider, deployment packaging, webhooks, and broader workflows remain deferred. The fake connector cannot execute a real refund.

## Notes on the paper

The paper is treated as a concept and tutorial prototype, not as production-ready guidance. The planning documents call out missing requirements, contradictions, and insecure assumptions before later phases are implemented.
