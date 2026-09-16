# File Map

This map separates the implemented Phase 1–5 repository from proposed Phase 6–10 components. Proposed paths are planning aids, not claims that those files or capabilities exist.

## Implemented tree

Dependency directories and generated dashboard output are intentionally omitted.

```text
README.md
.gitignore
package.json
package-lock.json
tsconfig.json
docs/
  ARCHITECTURE.md
  DATA_AND_API_DESIGN.md
  DECISIONS_AND_QUESTIONS.md
  FILE_MAP.md
  IMPLEMENTATION_PLAN.md
  PRODUCT_VISION_AND_AUTHORIZATION_FLOW.md
  SECURITY_AND_TESTING.md
  Agent-Authorization-Firewall-Research-and-Tutorial.pdf
apps/
  gateway/
    src/
      actions.ts
      app.ts
      approvals.ts
      audit.ts
      auth.ts
      canonicalize.ts
      config.ts
      db.ts
      errors.ts
      migrate.ts
      policy.ts
      server.ts
    test/
      actions.test.ts
      approvals.test.ts
      integration-support.ts
      policy.test.ts
      security.test.ts
  worker/
    src/
      audit.ts
      config.ts
      connector.ts
      db.ts
      outbox.ts
      reconciliation.ts
      reservations.ts
      server.ts
      worker.ts
    test/
      worker.test.ts
  dashboard/
    README.md
    index.html
    tsconfig.json
    vite.config.ts
    src/
      App.tsx
      api.ts
      main.tsx
      styles.css
    test/
      api.test.ts
packages/
  sdk/
    README.md
    package.json
    src/
      client.ts
      index.ts
      types.ts
    test/
      sdk.test.ts
  shared/
    src/
      canonical-request.ts
      errors.ts
      ids.ts
      policy-types.ts
      schema.ts
      states.ts
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
  compose/
    docker-compose.yml
```

## Implemented ownership

| Area | Implemented responsibility | Phase |
| --- | --- | --- |
| `packages/shared/` | Strict refund schema, canonical request hashing, policy facts, IDs, states, and domain errors | 1 |
| `apps/gateway/` | Development authentication, tenant-scoped action APIs, server-side policy, exact approvals, audit, and migrations | 1–3 |
| `db/` | PostgreSQL schema, immutable bindings, outbox, attempts, reservations, fake-provider ledger, and local fixtures | 1–4 |
| `apps/worker/` | Safe claiming, authorization rechecks, reservations, deterministic fake provider, and reconciliation | 4 |
| `packages/sdk/` | Typed transport client for existing action and approval APIs | 5 |
| `apps/dashboard/` | Local manager pending-approval review and exact-bound decisions | 5 |
| `docs/PRODUCT_VISION_AND_AUTHORIZATION_FLOW.md` | Target product experience, trusted-fact model, onboarding concept, and post-MVP direction | Roadmap |

## Proposed Phase 6–10 components

These paths do not exist yet and must only be added when their phase is authorized.

| Proposed component/path | Responsibility | Phase |
| --- | --- | --- |
| Production auth/session adapters under `apps/gateway/src/` | Workload identity, human sessions, expiration, rotation, revocation, and production exclusion of dev credentials | 6 |
| Proposed `packages/identity/` | Secret-manager and credential-lifecycle abstractions | 6 |
| `.github/workflows/verify.yml` or selected CI equivalent | Reproducible verification and build gates | 6 |
| `infra/docker/`, pilot manifests, `infra/sql/backup-check.sql`, `infra/sql/health-check.sql` | Images, deployment packaging, health, backup, and restore validation | 6 |
| Proposed `apps/admin/` | Initial administrator UI and later onboarding workflows | 7 and 10 |
| Proposed `packages/policy-admin/` | Permission schemas, policy validation, simulation, publication, rollback, and observation mode | 7 |
| Future administration routes and migrations | Tenants, principals, tool/resource scopes, limits, suspension, revocation, and kill-switch APIs | 7 |
| Proposed `packages/facts/` | `FactResolver`, canonical facts, provenance, freshness, and redaction | 8 |
| Proposed `packages/connectors/facts/` | Controlled order, shipping, or payment fact connectors | 8 |
| Proposed `apps/worker/src/connectors/` provider adapter | One selected refund-provider sandbox connector and reconciliation | 9 |
| Proposed `packages/adapters/` | MCP or selected agent-framework transport adapters | 10 |

The exact future names may change during design review. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) is authoritative for phase prerequisites, expected behavior, acceptance criteria, verification, and limitations.
