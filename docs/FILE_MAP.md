# File Map

This is the MVP file structure. Phases 1 through 5 exist for the gateway, deterministic worker, SDK, and local manager dashboard. Production authentication, provider integration, deployment packaging, and hardening remain proposed.

## Proposed tree

```text
README.md
docs/
  ARCHITECTURE.md
  DATA_AND_API_DESIGN.md
  DECISIONS_AND_QUESTIONS.md
  FILE_MAP.md
  IMPLEMENTATION_PLAN.md
  SECURITY_AND_TESTING.md
apps/
  gateway/
    src/
      app.ts
      server.ts
      config.ts
      auth.ts
      canonicalize.ts
      policy.ts
      actions.ts
      approvals.ts
      audit.ts
      db.ts
      errors.ts
    test/
      actions.test.ts
      approvals.test.ts
      policy.test.ts
      security.test.ts
  worker/
    src/
      worker.ts
      outbox.ts
      connector.ts
      reconciliation.ts
      reservations.ts
      db.ts
    test/
      worker.test.ts
      reconciliation.test.ts
      idempotency.test.ts
  dashboard/
    README.md
    index.html
    tsconfig.json
    vite.config.ts
    src/
      main.tsx
      App.tsx
      api.ts
      styles.css
    test/
      api.test.ts
packages/
  sdk/
    README.md
    package.json
    src/
      index.ts
      client.ts
      types.ts
    test/
      sdk.test.ts
  shared/
    src/
      ids.ts
      schema.ts
      canonical-request.ts
      states.ts
      errors.ts
      policy-types.ts
      audit-types.ts
    test/
      canonical-request.test.ts
      states.test.ts
db/
  migrations/
    0001_init.sql
    0002_actions_and_approvals.sql
    0003_outbox_and_audit.sql
    0004_approval_decisions.sql
    0005_worker_execution.sql
  seeds/
    local-dev.sql
infra/
  docker/
    Dockerfile.gateway
    Dockerfile.worker
    Dockerfile.dashboard
  compose/
    docker-compose.yml
  sql/
    backup-check.sql
    health-check.sql
```

## Planned MVP files

| Path | Purpose | Responsibilities | Dependencies | Phase |
| --- | --- | --- | --- | --- |
| README.md | Product and planning entry point | Explain scope, navigation, and status | None | Phase 0 |
| docs/ARCHITECTURE.md | System boundary reference | Components, trust boundaries, lifecycle | Paper review | Phase 0 |
| docs/DATA_AND_API_DESIGN.md | Data and API contract | Entities, state transitions, endpoints | Architecture | Phase 0 |
| docs/IMPLEMENTATION_PLAN.md | Ordered build plan | Phase breakdown and verification | All planning docs | Phase 0 |
| docs/SECURITY_AND_TESTING.md | Security model and test map | Invariants, threats, test coverage | Data/API, architecture | Phase 0 |
| docs/DECISIONS_AND_QUESTIONS.md | Decision log | Assumptions, tradeoffs, blockers | Paper review | Phase 0 |
| apps/gateway/src/app.ts | Fastify app assembly | Register routes, validation, plugins | config, db, auth, policy | Phase 1-3 |
| apps/gateway/src/server.ts | Local server entry | Start gateway process | app | Phase 1-2 |
| apps/gateway/src/config.ts | Runtime config loading | Ports, secrets, env validation | shared schema | Phase 1 |
| apps/gateway/src/auth.ts | Auth helpers | Derive tenant, roles, and permissions | config, shared types | Phase 1-3 |
| apps/gateway/src/canonicalize.ts | Request normalization | Stable hashes and request identity | shared canonical types | Phase 1-2 |
| apps/gateway/src/policy.ts | Authorization logic | Allow/deny/approval decisions | shared policy types | Phase 2 |
| apps/gateway/src/actions.ts | Action lifecycle routes | Create, fetch, and list actions | db, auth, policy | Phase 2 |
| apps/gateway/src/approvals.ts | Approval routes | Manager decisions and expiry checks | db, auth, policy | Phase 3 |
| apps/gateway/src/audit.ts | Audit event writer | Redacted event recording | db, shared audit types | Phase 2-4 |
| apps/gateway/src/db.ts | DB access helpers | Transaction wrappers and queries | pg client | Phase 1 |
| apps/gateway/src/errors.ts | API errors | Map domain errors to HTTP | shared errors | Phase 1 |
| apps/gateway/test/actions.test.ts | Action API tests | Validate request lifecycle | gateway app, db test harness | Phase 2 |
| apps/gateway/test/approvals.test.ts | Approval tests | Verify approval transitions and rejection | gateway app, db test harness | Phase 3 |
| apps/gateway/test/policy.test.ts | Policy tests | Allow/deny/approval boundaries | policy module | Phase 2 |
| apps/gateway/test/security.test.ts | Security tests | Tenant isolation, idempotency, expiry | gateway app | Phase 2-4 |
| apps/worker/src/worker.ts | Worker orchestration | Process and reconcile one durable job | db, connector, outbox | Phase 4 |
| apps/worker/src/outbox.ts | Outbox claiming | Claim, lease, and retry logic | db | Phase 4 |
| apps/worker/src/connector.ts | Restricted provider integration | Encapsulate provider call and idempotency | server secrets | Phase 4 |
| apps/worker/src/reconciliation.ts | Ambiguous outcome handling | Resolve crash/retry states | connector, db | Phase 4 |
| apps/worker/src/reservations.ts | Reservation logic | Reserve and release budget/order exposure | db | Phase 4 |
| apps/worker/src/db.ts | Worker DB access | Queries and transaction helpers | pg client | Phase 4 |
| apps/worker/test/worker.test.ts | Worker integration tests | Idempotent dispatch and crash recovery | worker, mock connector | Phase 4 |
| apps/worker/test/reconciliation.test.ts | Reconciliation tests | Ambiguous provider response handling | worker | Phase 4 |
| apps/worker/test/idempotency.test.ts | Idempotency tests | No duplicate provider side effects | worker, connector | Phase 4 |
| apps/dashboard/README.md | Dashboard guide | Local startup and manual review flow | gateway, worker | Phase 5 |
| apps/dashboard/vite.config.ts | Dashboard build/dev config | Vite root, build, local gateway proxy | Vite | Phase 5 |
| apps/dashboard/src/main.tsx | Dashboard bootstrap | Mount React app | React build setup | Phase 5 |
| apps/dashboard/src/App.tsx | Manager approval workspace | Credential setup, queue, detail, confirmation, decisions | SDK, api | Phase 5 |
| apps/dashboard/src/api.ts | Dashboard API adapter | Construct SDK client and present safe client errors | SDK | Phase 5 |
| apps/dashboard/src/styles.css | Dashboard presentation | Responsive manager-facing UI | dashboard components | Phase 5 |
| apps/dashboard/test/api.test.ts | Dashboard client tests | Complete pagination and stale decision messaging | dashboard API adapter | Phase 5 |
| packages/sdk/README.md | SDK guide | Agent action submission example and boundary | SDK | Phase 5 |
| packages/sdk/src/index.ts | SDK entry point | Public exports | client, types | Phase 5 |
| packages/sdk/src/client.ts | HTTP client | Call gateway, inject caller headers, and map errors | gateway API | Phase 5 |
| packages/sdk/src/types.ts | SDK types | Action request and status types | shared types | Phase 5 |
| packages/sdk/test/sdk.test.ts | SDK tests | Serialization, exact approval binding, pagination, and errors | sdk client | Phase 5 |
| packages/shared/src/ids.ts | ID helpers | Stable identifiers and generation rules | none | Phase 1 |
| packages/shared/src/schema.ts | Shared request schema | Canonical validation rules | policy, API | Phase 1-2 |
| packages/shared/src/canonical-request.ts | Canonical hash input | Stable request identity | schema, ids | Phase 1-2 |
| packages/shared/src/states.ts | State constants | Lifecycle and transition names | data design | Phase 1 |
| packages/shared/src/errors.ts | Domain error types | Shared error mapping | API design | Phase 1 |
| packages/shared/src/policy-types.ts | Policy decision types | Typed policy results | policy layer | Phase 2 |
| packages/shared/src/audit-types.ts | Audit event types | Redacted event payloads | audit design | Phase 2-4 |
| packages/shared/test/canonical-request.test.ts | Canonicalization tests | Stable hashing | shared module | Phase 1-2 |
| packages/shared/test/states.test.ts | State tests | Valid transition checks | shared module | Phase 1 |
| db/migrations/0001_init.sql | Initial schema | Tenants, users, actions, approvals, audit | data model | Phase 1 |
| db/migrations/0002_actions_and_approvals.sql | Action schema expansion | Canonical request, status, hash, expiry | initial schema | Phase 2-3 |
| db/migrations/0003_outbox_and_audit.sql | Worker and audit schema | Outbox, reservations, reconciliation | action schema | Phase 2 |
| db/migrations/0004_approval_decisions.sql | Approval resolution schema | Exact binding, manager decisions, expiry, pagination | action schema | Phase 3 |
| db/migrations/0005_worker_execution.sql | Worker execution schema | Attempts, reservations, leases, fake ledger, kill switch | action and outbox schema | Phase 4 |
| db/seeds/local-dev.sql | Local seed data | Demo tenant and fixture records | migrations | Phase 1 |
| infra/docker/Dockerfile.gateway | Gateway container image | Build/runtime packaging | gateway app | Phase 6 |
| infra/docker/Dockerfile.worker | Worker container image | Build/runtime packaging | worker app | Phase 6 |
| infra/docker/Dockerfile.dashboard | Dashboard container image | Build/runtime packaging | dashboard app | Phase 6 |
| infra/compose/docker-compose.yml | Local stack | Postgres + gateway + worker + dashboard | all runtime services | Phase 1 and 6 |
| infra/sql/backup-check.sql | Recovery check script | Verify backups and restore path | PostgreSQL | Phase 6 |
| infra/sql/health-check.sql | Health check query | Simple liveness/readiness query | PostgreSQL | Phase 6 |
