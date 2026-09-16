# Agent Authorization Firewall

This repository contains the completed and verified Phase 1–6 refund firewall. All repository-controlled Phase 6 acceptance checks pass; pilot activation still requires a real OIDC client registration, an exact HTTPS callback origin, and operator-installed deployment secrets.

The implemented backend is a constrained authorization firewall for AI agents: a TypeScript/Fastify/PostgreSQL system that decides whether an agent action may execute, requires human approval for selected actions, and then dispatches work through a background worker with durable state and auditability. The paper’s narrow starting point is the refund workflow, and this plan keeps that as the first implementation slice.

## What to read first

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system boundaries and lifecycle.
2. [docs/PRODUCT_VISION_AND_AUTHORIZATION_FLOW.md](docs/PRODUCT_VISION_AND_AUTHORIZATION_FLOW.md) for the long-term user experience, permission configuration, trusted fact verification, onboarding, and post-MVP roadmap.
3. [docs/DATA_AND_API_DESIGN.md](docs/DATA_AND_API_DESIGN.md) for the currently implemented entities, states, and endpoints.
4. [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for phase status and the dependency-ordered roadmap.
5. [docs/SECURITY_AND_TESTING.md](docs/SECURITY_AND_TESTING.md) for invariants and test coverage.
6. [docs/DECISIONS_AND_QUESTIONS.md](docs/DECISIONS_AND_QUESTIONS.md) for assumptions, tradeoffs, and blockers.
7. [docs/FILE_MAP.md](docs/FILE_MAP.md) for implemented files and clearly labeled future components.
8. [docs/PHASE_6_DESIGN.md](docs/PHASE_6_DESIGN.md) for production identity, sessions, secrets, health, metrics, packaging, and recovery decisions.

## Initial scope

The MVP starts with the refund authorization flow described in the paper:

- An authenticated client submits a refund action to the gateway.
- Fastify validates the request, derives tenant identity server-side, and records an immutable action.
- The policy layer returns allow, deny, or require approval.
- A manager approves or rejects the exact request.
- A background worker performs execution with idempotency, reconciliation, and audit logging.

The gateway accepts authenticated refund actions and managers can resolve exact tenant-scoped approvals. The Phase 4 worker leases queued work, rechecks authorization, reserves capacity, and calls only a narrow provider connector. The default connector is a deterministic PostgreSQL-backed fake: it makes no network calls and moves no real money.

## Local development startup

Prerequisites: Node.js with npm and Docker with Compose.

```sh
npm install
cp infra/compose/.env.development.example infra/compose/.env.development.local
docker compose --env-file infra/compose/.env.development.local -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.development.yml up -d postgres
FIAR_RUNTIME_MODE=development \
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

The ignored `.env.development.local` file supplies the obvious local-only credentials to the development override. The complete containerized development stack uses those credentials and the fake provider:

```sh
docker compose --env-file infra/compose/.env.development.local -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.development.yml up --build
```

In production mode, agents/services use SDK bearer credentials created by the local operator CLI, while managers/admins use OIDC and PostgreSQL-backed sessions. Production rejects development credential configuration and headers. Safe operational endpoints are `/health/live`, `/health/ready`, and the separately authenticated `/metrics`; metrics remain internal in Compose.

## Production-like pilot packaging

Copy `infra/compose/.env.example` to an ignored `.env.production.local` file and copy each `infra/compose/secrets/*.example` to operator-controlled paths; replace every placeholder with an independently generated value; register the exact HTTPS OIDC callback; and point the Compose secret variables at those files. A public OIDC client may use a safe, empty regular file for the optional client-secret path. Then run:

```sh
docker compose --env-file infra/compose/.env.production.local -f infra/compose/docker-compose.yml config
docker compose --env-file infra/compose/.env.production.local -f infra/compose/docker-compose.yml up --build
```

The checked-in examples are not pilot secrets. Until an external issuer/client and final callback origin are selected and verified, Phase 6 is not an activated pilot deployment. Credential lifecycle and secret names are documented in [docs/PHASE_6_DESIGN.md](docs/PHASE_6_DESIGN.md).

Backup verification always restores into a temporary `fiar_restore_*` database:

```sh
FIAR_DATABASE_URL='postgresql://…/fiar' FIAR_BACKUP_FILE=/absolute/path/fiar.backup infra/scripts/backup.sh
FIAR_ADMIN_DATABASE_URL='postgresql://…/postgres' FIAR_BACKUP_FILE=/absolute/path/fiar.backup infra/scripts/restore-verify.sh
```

The recovery scripts use local PostgreSQL client tools when installed. In container-only environments, set `FIAR_PG_TOOLS_CONTAINER` to the exact PostgreSQL 16 container ID/name; CI uses its isolated service container this way.

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

Run `npm run verify` for the complete deterministic non-container suite: strict typechecking, unit/security tests, PostgreSQL gateway/CLI/worker suites, shutdown tests, SDK/dashboard checks, the production dashboard build, real-browser fake-OIDC tests, link checking, and repository hygiene. Integration and browser harnesses create unique temporary databases and drop only those databases; they do not reset the seeded `fiar` database or delete Docker volumes.

The remaining operational gates are explicit:

```sh
npm run verify:alerts       # pinned promtool validation (Docker fallback)
npm run verify:containers   # unique production-mode Compose project and fake OIDC
```

The production smoke generates temporary mounted secrets, applies migrations, proves production rejects development authentication, creates a hashed workload credential, executes one fake-provider action, checks health/readiness/metrics, verifies non-root images, and removes only its uniquely named stack and volume. Alert meanings and first actions are in [docs/OPERATIONS_RUNBOOK.md](docs/OPERATIONS_RUNBOOK.md).

The SDK and dashboard remain clients only: policy, identity, tenant scope, approval binding, execution, and reconciliation are server-side. A real payment provider, external fact connectors, policy administration, webhooks, and broader workflows remain deferred. The fake connector cannot execute a real refund.

## Notes on the paper

The paper is treated as a concept and tutorial prototype, not as production-ready guidance. The planning documents call out missing requirements, contradictions, and insecure assumptions before later phases are implemented.
