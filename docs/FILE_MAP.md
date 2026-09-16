# File Map

This map separates implemented Phases 1–6 from proposed Phase 7–10 components. Proposed paths are planning aids, not claims that those capabilities exist.

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
  PHASE_6_DESIGN.md
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
      admin-cli.ts
      canonicalize.ts
      config.ts
      csrf.ts
      db.ts
      errors.ts
      metrics.ts
      migrate.ts
      oidc.ts
      policy.ts
      security-audit.ts
      server.ts
    test/
      actions.test.ts
      approvals.test.ts
      integration-support.ts
      policy.test.ts
      phase6.test.ts
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
      e2e.spec.ts
      e2e-server.ts
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
      audit-redaction.ts
      operational-log.ts
      graceful-shutdown.ts
      policy-types.ts
      runtime.ts
      schema.ts
      secrets.ts
      secure-values.ts
      states.ts
    test/
      canonical-request.test.ts
      phase6-security.test.ts
      states.test.ts
db/
  migrations/
    0001_init.sql
    0002_actions_and_approvals.sql
    0003_outbox_and_audit.sql
    0004_approval_decisions.sql
    0005_worker_execution.sql
    0006_phase6_identity_and_operations.sql
    0007_phase6_acceptance.sql
  seeds/
    local-dev.sql
infra/
  compose/
    docker-compose.yml
    docker-compose.development.yml
    docker-compose.production-smoke.yml
    .env.example
    .env.development.example
    secrets/*.example
  docker/
    Dockerfile.gateway
    Dockerfile.worker
    Dockerfile.dashboard
    Dockerfile.fake-oidc
    nginx-dashboard.conf
  scripts/
    backup.sh
    restore-verify.sh
    check-repository-hygiene.mjs
    check-markdown-links.mjs
    verify-alerts.sh
    verify-production-containers.sh
  monitoring/
    alerts.yml
  testing/
    fake-oidc.mjs
  sql/
    backup-check.sql
    health-check.sql
.github/workflows/verify.yml
playwright.config.ts
.dockerignore
```

## Implemented ownership

| Area | Implemented responsibility | Phase |
| --- | --- | --- |
| `packages/shared/` | Strict refund schema, canonical request hashing, policy facts, IDs, states, and domain errors | 1 |
| `apps/gateway/` | Runtime-separated workload/session authentication, OIDC/PKCE, CSRF, tenant-scoped action/approval APIs, audit, health, metrics, and migrations | 1–3, 6 |
| `db/` | PostgreSQL schema, immutable bindings, outbox, attempts, reservations, fake-provider ledger, and local fixtures | 1–4 |
| `apps/worker/` | Safe claiming, authorization rechecks, reservations, deterministic fake provider, reconciliation, health/metrics, and bounded shutdown | 4, 6 |
| `packages/sdk/` | Typed transport client with development/custom headers and production workload bearer support | 5–6 |
| `apps/dashboard/` | Development memory-only credential mode and production OIDC/session/CSRF manager review | 5–6 |
| `infra/` and `.github/` | Non-root images, development and isolated production Compose, alert rules, migration/recovery checks, hygiene, and CI | 6 |
| `docs/PRODUCT_VISION_AND_AUTHORIZATION_FLOW.md` | Target product experience, trusted-fact model, onboarding concept, and post-MVP direction | Roadmap |

## Proposed Phase 7–10 components

These paths do not exist yet and must only be added when their phase is authorized.

| Proposed component/path | Responsibility | Phase |
| --- | --- | --- |
| Proposed `apps/admin/` | Initial administrator UI and later onboarding workflows | 7 and 10 |
| Proposed `packages/policy-admin/` | Permission schemas, policy validation, simulation, publication, rollback, and observation mode | 7 |
| Future administration routes and migrations | Tenants, principals, tool/resource scopes, limits, suspension, revocation, and kill-switch APIs | 7 |
| Proposed `packages/facts/` | `FactResolver`, canonical facts, provenance, freshness, and redaction | 8 |
| Proposed `packages/connectors/facts/` | Controlled order, shipping, or payment fact connectors | 8 |
| Proposed `apps/worker/src/connectors/` provider adapter | One selected refund-provider sandbox connector and reconciliation | 9 |
| Proposed `packages/adapters/` | MCP or selected agent-framework transport adapters | 10 |

The exact future names may change during design review. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) is authoritative for phase prerequisites, expected behavior, acceptance criteria, verification, and limitations.
