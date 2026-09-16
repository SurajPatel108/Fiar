# Implementation Plan

## Structure

The implementation is split into three layers:

1. Local learning prototype.
2. Functional MVP.
3. Production hardening.

Each phase is intentionally small so it can be built, reviewed, and tested independently.

## Phase 0: Planning baseline

Goal: finish the documentation set and agree on the unresolved decisions before code starts.

Status: complete.

Tasks:

- Review the paper’s refund workflow and the limitations of the tutorial code.
- Finalize the MVP scope around one refund action, one tenant model, and one manager approval flow.
- Record all blocked decisions in [DECISIONS_AND_QUESTIONS.md](DECISIONS_AND_QUESTIONS.md).

Acceptance criteria:

- The documentation set is complete.
- The narrow refund workflow is explicitly identified as the first implementation slice.
- Unresolved questions are separated from assumptions.

Completed deliverables:

- README.md
- docs/ARCHITECTURE.md
- docs/FILE_MAP.md
- docs/DATA_AND_API_DESIGN.md
- docs/IMPLEMENTATION_PLAN.md
- docs/SECURITY_AND_TESTING.md
- docs/DECISIONS_AND_QUESTIONS.md

Verification:

- Manual review of all seven planning documents.

## Phase 1: Shared contracts and local prototype boundary

Goal: define stable types and a pure policy core without external dependencies.

Status: complete.

Tasks:

1. Define shared action, state, and error types.
2. Define canonical request normalization and hashing rules.
3. Implement a pure refund policy function for the tutorial prototype.
4. Write unit tests for amount thresholds, tool allowlist, tenant-independent facts, and denial precedence.

Prerequisites:

- Phase 0 decisions.

Files to create or change:

- packages/shared/src/ids.ts
- packages/shared/src/schema.ts
- packages/shared/src/canonical-request.ts
- packages/shared/src/states.ts
- packages/shared/src/errors.ts
- packages/shared/src/policy-types.ts
- packages/shared/test/canonical-request.test.ts
- packages/shared/test/states.test.ts
- apps/gateway/src/policy.ts
- apps/gateway/test/policy.test.ts

Expected behavior:

- The policy can return allow, deny, or require approval from supplied facts.
- Canonicalization produces the same hash for semantically identical requests.
- No network or database access is required for the learning prototype.

Acceptance criteria:

- The policy tests pass.
- Canonical hashes are stable across repeated runs.
- Denials happen before approval when a request is invalid.

Verification steps:

- Run the shared unit tests.
- Run the policy tests.

Completed deliverables:

- packages/shared/src/ids.ts
- packages/shared/src/schema.ts
- packages/shared/src/canonical-request.ts
- packages/shared/src/states.ts
- packages/shared/src/errors.ts
- packages/shared/src/policy-types.ts
- packages/shared/test/canonical-request.test.ts
- packages/shared/test/states.test.ts
- apps/gateway/src/policy.ts
- apps/gateway/test/policy.test.ts

## Phase 2: Gateway request intake and immutable action creation

Goal: accept authenticated refund requests, derive tenant identity server-side, and persist immutable actions.

Status: complete.

Tasks:

1. Add gateway configuration and authentication helpers.
2. Add the action creation endpoint.
3. Persist the immutable action, decision event, and either approval request or outbox row in one transaction.
4. Enforce idempotency and request-hash conflict handling.
5. Add action lookup and tenant-scoped listing endpoints.

Prerequisites:

- Phase 1 shared types.
- Database schema for actions and idempotency.
- Database schema for policy versions, authoritative order facts, and outbox rows.

Files to create or change:

- apps/gateway/src/app.ts
- apps/gateway/src/server.ts
- apps/gateway/src/config.ts
- apps/gateway/src/auth.ts
- apps/gateway/src/canonicalize.ts
- apps/gateway/src/actions.ts
- apps/gateway/src/audit.ts
- apps/gateway/src/db.ts
- apps/gateway/src/errors.ts
- apps/gateway/test/actions.test.ts
- apps/gateway/test/security.test.ts
- db/migrations/0001_init.sql
- db/migrations/0002_actions_and_approvals.sql
- db/migrations/0003_outbox_and_audit.sql
- db/seeds/local-dev.sql

Expected behavior:

- A valid refund request is recorded exactly once.
- A repeated idempotent request returns the original action.
- A conflicting replay with the same idempotency key but different content returns a conflict.
- Wrong-tenant access never reveals another tenant’s action.

Acceptance criteria:

- Duplicate submissions do not create duplicate actions.
- Unauthorized or cross-tenant requests are rejected.
- An explicit denial never touches the worker path.

Verification steps:

- Create a request twice and confirm the same action identifier is returned.
- Attempt a wrong-tenant read and confirm it fails closed.
- Force a transaction rollback and verify no partial action remains.

Completed deliverables:

- Authenticated `POST /v1/actions`, `GET /v1/actions/:id`, and bounded keyset-paginated `GET /v1/actions`.
- Transactional PostgreSQL persistence for actions, audit decisions, pending approvals, and outbox entries.
- Durable tenant-scoped idempotency, including simultaneous replay recovery after rollback.
- Immutable action and published-policy constraints plus tenant-consistent composite foreign keys.
- Development seed/migration runner and isolated PostgreSQL integration harness.
- Integration coverage for all Phase 2 intake, isolation, durability, rollback, pagination, and redaction acceptance cases.

Verification:

- `npm run typecheck`
- `npm test`
- `npm run test:integration` against PostgreSQL 16

## Phase 3: Human approval flow

Goal: require exact manager approval for threshold actions and invalidate stale approvals.

Status: complete (backend API); the manager dashboard was delivered in Phase 5.

Tasks:

1. Add approval records tied to the immutable action hash.
2. Add manager-only approval and rejection endpoints.
3. Add list/detail views for pending, completed, and expired approvals.
4. Revalidate tenant, manager role, policy version, request hash, expiry, and pending status on every approval decision.

Prerequisites:

- Phase 2 action storage.

Files to create or change:

- apps/gateway/src/approvals.ts
- apps/gateway/test/approvals.test.ts
- db/migrations/0004_approval_decisions.sql

Expected behavior:

- Manager decisions affect only the exact pending action.
- Changed or expired requests cannot reuse an old approval.
- Agent credentials are rejected by manager-only endpoints.

Acceptance criteria:

- Approving the same request twice does not enqueue another logical action.
- Rejected or expired approvals cannot be replayed.
- Editing the request creates a new action rather than mutating the approved one.

The approval path binds the stored approval to the action's exact request hash and policy version, and also requires that policy version to remain active at decision time.

Verification steps:

- Approve the threshold fixture and confirm it moves forward once.
- Expire an approval and confirm the old decision is unusable.
- Call the approval endpoint with an agent credential and confirm authorization fails.

Completed deliverables:

- Manager/admin-only approval list, detail, approve, and reject APIs.
- Stable bounded approval pagination and status filtering.
- Transactional exact-binding, expiry, policy-staleness, suspension, concurrency, rollback, audit, and outbox behavior.
- Durable `approved`, `rejected`, and `expired` approval records; rejection maps the action to `denied`.
- PostgreSQL integration coverage for all backend Phase 3 acceptance criteria.

Verification:

- `npm run verify` passes strict TypeScript, 7 Phase 1 tests, and 36 Phase 2/3 PostgreSQL integration tests.

Dashboard status:

- Delivered in Phase 5 as a client of these unchanged manager-only APIs.

## Phase 4: Worker, outbox, and provider reconciliation

Goal: perform durable execution with idempotency, reservation safety, and crash recovery.

Status: complete for the deterministic fake provider boundary.

Tasks:

1. Add the worker process and outbox leasing.
2. Add budget and order reservation logic.
3. Add a mock connector with a durable side-effect ledger.
4. Handle ambiguous provider outcomes with reconciliation instead of blind retries.
5. Confirm no duplicate provider effect after worker crashes.

Prerequisites:

- Phase 2 approval-ready action storage.
- Phase 2 outbox schema.

Files to create or change:

- apps/worker/src/worker.ts
- apps/worker/src/outbox.ts
- apps/worker/src/connector.ts
- apps/worker/src/reconciliation.ts
- apps/worker/src/reservations.ts
- apps/worker/src/db.ts
- apps/worker/test/worker.test.ts
- apps/worker/test/reconciliation.test.ts
- apps/worker/test/idempotency.test.ts

Expected behavior:

- Only one worker instance should claim a given item at a time.
- A crash after provider success does not create a second side effect.
- Suspension prevents new dispatch authorization for queued work.
- An ambiguous provider response moves to `pending_reconciliation`, not back to plain `queued`.

Acceptance criteria:

- Two concurrent requests for the last available budget do not both dispatch.
- A crash/restart sequence preserves exactly one provider side effect.
- An unknown provider outcome is tracked as unresolved rather than assumed to be safe.

Verification steps:

- Run a concurrency test with two competing refunds.
- Simulate a crash immediately after provider success.
- Suspend the tenant or agent while work is queued and confirm no new dispatch occurs.
- Simulate an unknown provider response and confirm the attempt stays in pending reconciliation until resolved.

Completed deliverables:

- PostgreSQL-safe outbox claiming with `FOR UPDATE SKIP LOCKED`, leases, expired-lease recovery, and bounded retry attempts.
- Immediate pre-execution revalidation of tenant, requester, action, approval, policy, kill switch, and exact outbox payload.
- Transactional order/budget reservations that are consumed on success, released on safe failure, and retained during ambiguity.
- Provider-neutral refund connector plus a deterministic, durable, idempotent fake provider ledger.
- Durable execution attempts covering success, confirmed failure, pre-provider retryable failure, and ambiguous outcomes.
- Reconciliation for confirmed success, confirmed non-execution, confirmed failure, and unresolved outcomes.
- Redacted worker claim, execution, authorization failure, kill-switch, and reconciliation audit events.
- Development worker entry point and 13 real PostgreSQL integration scenarios.

Verification:

- `npm run verify` passes strict TypeScript, 7 Phase 1 tests, 36 Phase 2/3 integration tests, and 13 Phase 4 worker tests.

Limitations:

- Only the fake provider connector exists; it uses a local PostgreSQL ledger and performs no network or payment operation.
- Kill-switch administration is intentionally limited to direct local database administration in this phase.

## Phase 5: SDK and manager UI integration

Goal: expose a usable client library and dashboard without weakening the server-side boundary.

Status: complete for the typed HTTP SDK and local-development manager dashboard.

Tasks:

1. Add the TypeScript SDK client for actions and approvals.
2. Wire the dashboard to the gateway APIs.
3. Display actionable status, reasons, and policy versions.
4. Keep the local dashboard credential in memory only and preserve server-derived authorization.

Prerequisites:

- Phase 2 gateway APIs.
- Phase 3 approvals.

Files to create or change:

- packages/sdk/src/index.ts
- packages/sdk/src/client.ts
- packages/sdk/src/types.ts
- packages/sdk/test/sdk.test.ts
- packages/sdk/README.md
- apps/dashboard/index.html
- apps/dashboard/vite.config.ts
- apps/dashboard/tsconfig.json
- apps/dashboard/src/main.tsx
- apps/dashboard/src/App.tsx
- apps/dashboard/src/api.ts
- apps/dashboard/src/styles.css
- apps/dashboard/test/api.test.ts
- apps/dashboard/README.md

Expected behavior:

- The SDK submits and retrieves actions, lists and retrieves approvals, and makes exactly bound decisions.
- The dashboard shows pending approvals and exact approval details, and requires confirmation for decisions.
- Neither client evaluates policy or accesses worker/provider controls.

Acceptance criteria:

- SDK requests serialize exactly to the gateway schema.
- The dashboard reads only tenant-visible records.
- Every dashboard decision includes the detail response's exact request hash and policy version.
- Local dashboard credentials are not persisted in browser storage or source code.

Verification steps:

- Run SDK request serialization tests.
- Run the dashboard strict typecheck and production build.
- Open the dashboard against seeded data and confirm the pending list, detail, confirmation, decision, and refresh flow.

Completed deliverables:

- Transport-only `FiarClient` with typed action, approval, pagination, decision, and error contracts.
- Caller-supplied credential headers and exact-binding approve/reject convenience methods.
- Seven mocked-transport SDK tests covering serialization, methods, URLs, pagination, development and workload credential headers, bindings, API failures, and transport failures.
- Responsive Vite/React manager dashboard with a pending queue, safe detail view, confirmation dialog, and explicit success/conflict/error states.
- In-memory local credential entry and same-origin development proxy; no gateway authorization or execution routes were added.
- Three dashboard behavior tests covering complete keyset pagination, repeated-cursor protection, and stale decision messaging.
- Dashboard strict TypeScript check, production build, local startup guide, and manual demo flow.

Verification:

- The Phase 1–5 baseline passes strict TypeScript, 7 unit tests, 35 gateway integration tests, 13 worker tests, 7 SDK tests, 3 dashboard behavior tests, and the dashboard typecheck/build.

Limitations:

- The dashboard credential entry remains local-only; Phase 6 adds the separate production OIDC/session path.
- SDK polling helpers, broader component/browser automation, broader workflows, and a production provider remain deferred. Dashboard container packaging is delivered by Phase 6.

## Phase 6: Operational and identity hardening

Goal: make the existing refund MVP deployable for a controlled internal pilot with production-grade identities, secret handling, health signals, recovery, and observability, without adding a real provider.

Status: complete and locally verified for every repository-controlled acceptance item. Pilot activation is separately blocked on selecting/registering a real OIDC client, fixing the deployment HTTPS origin, and installing independently generated secrets. See [PHASE_6_DESIGN.md](PHASE_6_DESIGN.md).

Prerequisites:

- Completed Phases 1–5 and their verification suites.
- The workload, OIDC, session, mounted-secret, and operational design recorded in `PHASE_6_DESIGN.md`.
- A real OIDC provider registration and pilot deployment environment are still required for activation.

Tasks:

1. Add production workload authentication for agents and services.
2. Add production authentication and managed sessions for managers and administrators.
3. Integrate a secret manager and define credential issuance, expiration, rotation, and revocation.
4. Exclude the development credential adapter from production runtime paths.
5. Add gateway, worker, database, and connector health/readiness checks.
6. Add CI verification and reproducible gateway, worker, and dashboard container images.
7. Complete local and pilot deployment packaging.
8. Validate database backup and restoration procedures.
9. Enforce audit redaction and add browser/session-security testing.
10. Add metrics and alerts for denials, approvals, retries, duplicate prevention, reconciliation, and provider failures.

Proposed files/components:

- Production authentication, OIDC, session, CSRF, health, metrics, and operator modules under `apps/gateway/src/`.
- Runtime, mounted-secret, cryptographic, logging, and audit-redaction utilities under `packages/shared/src/`.
- Gateway and worker health/readiness handlers.
- `.github/workflows/verify.yml`.
- `infra/docker/Dockerfile.gateway`, `Dockerfile.worker`, and `Dockerfile.dashboard`.
- Pilot/development Compose manifests, guarded recovery scripts, and `infra/sql/backup-check.sql` / `health-check.sql`.
- Identity, session, redaction, health, restore, and operational failure tests.

Expected behavior:

- Production runtimes reject development credentials and fail closed when identity, policy, audit, database, or required secret infrastructure is unavailable.
- Operators can distinguish liveness, readiness, degraded dependencies, retry pressure, and unresolved reconciliation.
- Credential revocation prevents new authority while preserving durable handling of already in-flight provider outcomes.

Acceptance criteria:

- Agent/service identities and manager/admin sessions are tenant-scoped, expiring, revocable, and tested.
- No production secret is committed, returned to clients, or emitted in logs/audits.
- CI reproduces the complete verification suite and container builds.
- Backup restoration is exercised successfully in an isolated environment.
- Operational metrics and alerts cover every listed lifecycle signal.

Verification steps:

- Run workload and human-authentication integration tests, including expiration, rotation, revocation, CSRF/session, and tenant-isolation cases.
- Build and scan all images; start the packaged pilot stack and exercise readiness failure modes.
- Restore an isolated backup and compare required records and constraints.
- Inject database, secret-manager, and dependency failures and verify fail-closed behavior and alerts.
- Review stored and emitted audit/log samples for secrets.

Completed verification:

- `npm run verify` passes strict TypeScript, 15 unit/security/policy tests, 46 gateway integration tests, 8 operator CLI tests, 8 dedicated shutdown tests, 20 worker tests, 7 SDK tests, 3 dashboard tests, the production dashboard build, 20 real-browser fake-OIDC tests, hygiene, and Markdown-link checks.
- `npm run verify:alerts` validates seven actionable alert rules with pinned Prometheus 2.55.1 tooling.
- `npm run verify:containers` builds gateway, worker, dashboard, and local test-issuer images and runs a unique production-mode Compose stack through migration, file-secret loading, production auth rejection/success, fake-provider execution, readiness, metrics, non-root checks, and scoped teardown.
- The browser suite verifies PKCE, one-use browser-bound state, nonce and callback failures, secure cookie attributes, CSRF, logout, idle refresh, expired/revoked sessions, manager role enforcement, empty browser storage, and malicious redirect parameters.
- The guarded backup script restores into a random `fiar_restore_*` database, validates Phase 6 migrations and critical constraints, and removes only that temporary database.

Limitations:

- Phase 6 does not introduce a real refund provider, administrative policy authoring, external fact connectors, or broader action types.
- The deterministic fake provider remains the only execution connector.
- A conforming OIDC client is implemented and tested locally, but no external issuer/client is selected or registered; pilot activation remains blocked on that deployment decision.

## Phase 7: Administration and policy control plane

Goal: let authorized administrators manage tenants, principals, scoped permissions, limits, policy lifecycle, and emergency controls through a separately authorized control plane.

Status: proposed; not implemented.

Prerequisites:

- Phase 6 production identities, managed administrator sessions, secret handling, CI, and audit enforcement.
- A reviewed administrative authorization and separation-of-duties model.

Tasks:

1. Add tenant administration and agent/service registration.
2. Configure per-agent allowed tools and resource/environment scopes.
3. Configure per-agent amount, rate, concurrency, and budget limits.
4. Add agent suspension and credential revocation workflows.
5. Support draft, published, retired, and rolled-back policy versions.
6. Add policy validation, deterministic simulation, and shadow/observation mode.
7. Add administrative kill-switch APIs with strict authorization.
8. Audit every policy, identity, permission, credential, and kill-switch change.
9. Build the initial administrator UI.

Proposed files/components:

- A proposed `apps/admin/` TypeScript/React application.
- Gateway administration routes and dedicated admin authorization middleware.
- Proposed `packages/policy-admin/` schemas, validation, simulation, and publication services.
- Forward database migrations for permission scopes, limits, policy lifecycle, and administrative audit records.
- Administration API, permission-boundary, concurrency-limit, simulation, rollback, and UI tests.

Expected behavior:

- Only separately authorized administrators can change principals, permissions, limits, policy state, credentials, or kill switches.
- Published policy snapshots remain immutable; rollback activates a prior immutable version rather than editing history.
- Simulation and observation mode produce non-executing results that cannot create outbox work.

Acceptance criteria:

- Per-agent tool, resource, environment, amount, rate, concurrency, and budget rules are server-enforced.
- Suspension/revocation prevents new authority and is rechecked before dispatch.
- Invalid policies cannot publish, every change is auditable, and rollback is deterministic.
- Administrative kill-switch operations are tenant-scoped, authorized, and tested.

Verification steps:

- Run cross-tenant and role-escalation tests for every administration endpoint.
- Simulate representative policies and compare results with enforced decisions.
- Race rate, concurrency, and budget limits and prove aggregate enforcement.
- Publish, retire, and roll back versions while approvals and work are pending.
- Verify observation mode never queues execution.

Limitations:

- Phase 7 does not add external fact sources or a real provider.
- The initial administrator UI is intentionally narrow and does not generalize the current refund schema into arbitrary executable code.

## Phase 8: Trusted fact resolver and connectors

Goal: replace fixture-only fact loading with a provider-neutral, provenance-aware resolver that obtains required facts from controlled sources and fails closed when facts are missing or stale.

Status: proposed; not implemented.

Prerequisites:

- Phase 7 validated policy declarations and administrative connector configuration.
- Approved canonical fact naming, schema, provenance, freshness, and redaction conventions.

Tasks:

1. Define a provider-neutral `FactResolver` boundary.
2. Add required-fact declarations to policy definitions.
3. Define canonical fact names and value schemas.
4. Record source system, resource identifier, retrieval timestamp, source record version, and maximum age.
5. Enforce missing/stale-fact fail-closed behavior.
6. Add connector health reporting, fact redaction, and data minimization.
7. Implement one sandbox or controlled order-data connector.
8. Implement one additional shipping or payment fact connector.
9. Revalidate critical mutable facts before execution.
10. Prove that agent-supplied claims cannot replace decisive trusted facts.

Proposed files/components:

- Proposed `packages/facts/` contracts, canonical schemas, resolver, freshness logic, and redaction.
- Proposed `apps/gateway/src/fact-resolution/` orchestration.
- Read-only connector adapters under a proposed `packages/connectors/facts/` boundary.
- Forward migrations for connector configuration and fact provenance snapshots.
- Resolver contract, stale/missing fact, connector-health, minimization, provenance, and pre-execution revalidation tests.

Expected behavior:

- Policy declares the facts it requires; Fiar resolves them from configured authoritative sources rather than accepting decisive agent assertions.
- Every decisive fact carries provenance and freshness metadata and is minimized before storage or display.
- Missing, stale, unhealthy, malformed, or mismatched facts fail closed.

Acceptance criteria:

- The two controlled connectors map source records into validated canonical facts.
- Maximum-age rules are deterministic and use trusted timestamps/source versions.
- Critical fact changes between authorization and execution prevent unsafe dispatch.
- Tests demonstrate that manipulated request context cannot self-assert eligibility.

Verification steps:

- Run connector contract tests with valid, missing, malformed, stale, and unavailable responses.
- Attempt to substitute agent-provided values for every decisive fact.
- Change a critical source record after authorization and confirm worker revalidation blocks dispatch.
- Review stored facts and UI/API responses for minimization and redaction.

Limitations:

- Phase 8 connectors are controlled/sandbox or read-only; they do not perform refunds.
- Generic arbitrary-source scripting and unrestricted administrator code are out of scope.

## Phase 9: Real provider sandbox pilot

Goal: execute the proven refund lifecycle against one narrowly scoped provider sandbox in a controlled pilot while retaining deterministic fake-provider coverage.

Status: proposed and blocked on provider selection; not implemented.

Prerequisites:

- Phase 6 operational/identity hardening and Phase 8 critical-fact revalidation.
- A documented provider decision covering sandbox access, credential scope, idempotency, result lookup, webhook requirements, limits, and failure behavior.
- Security and legal approval for the controlled pilot.

Tasks:

1. Implement one narrowly scoped refund-provider sandbox connector.
2. Hold provider credentials only in the worker through the secret-manager boundary.
3. Enforce provider-side idempotency and result lookup/reconciliation.
4. Verify signed webhooks if the selected provider requires them.
5. Add monetary and rate limits independent of agent input.
6. Add sandbox failure injection and emergency provider shutdown.
7. Display human-visible execution and reconciliation status.
8. Operate a controlled pilot environment while keeping the deterministic fake provider for all default tests.

Proposed files/components:

- A provider-specific connector under a proposed `apps/worker/src/connectors/` boundary after selection.
- Provider secret configuration, lookup/reconciliation, and optional webhook verification adapters.
- Pilot-only status surfaces that expose safe execution state but never provider credentials.
- Provider contract, idempotency, webhook, limit, shutdown, ambiguity, and failure-injection tests.

Expected behavior:

- Only the worker can call the selected sandbox, using least-privilege credentials and stable idempotency keys.
- Ambiguous results enter reconciliation and are never blindly retried.
- Emergency shutdown blocks new sandbox calls without misreporting in-flight results.

Acceptance criteria:

- Repeated delivery produces one provider-side sandbox effect.
- Lookup and webhook flows converge durable local state after lost responses.
- Monetary/rate limits and emergency shutdown are enforced under concurrency.
- Human users can distinguish queued, dispatched, unresolved, failed, and completed states without seeing secrets.

Verification steps:

- Run the provider's sandbox contract suite and Fiar failure-injection matrix.
- Simulate timeout after provider success, duplicate delivery, delayed webhook, invalid signature, rate limiting, and shutdown races.
- Reconcile provider and local ledgers for the complete pilot dataset.
- Keep the existing fake-provider suite as a required CI gate.

Limitations:

- Provider selection is unresolved; no production provider or live-money execution is authorized by this plan.
- The pilot remains limited to the refund workflow, sandbox credentials, bounded amounts, and approved tenants.

## Phase 10: Product onboarding and broader integrations

Goal: turn the hardened refund pilot into a guided product experience and add integration adapters without expanding action types before the refund workflow is stable.

Status: proposed; not implemented.

Prerequisites:

- Phases 6–9 meet their acceptance criteria in the controlled pilot.
- Stable administration, fact, provider, identity, and policy contracts.

Tasks:

1. Add organization onboarding and an agent setup wizard.
2. Add permission and policy configuration workflows.
3. Add fact-source and provider connection workflows.
4. Add approver-role configuration and SDK credential issuance.
5. Require policy testing before activation.
6. Guide observation/shadow-mode rollout before enforcement and execution.
7. Add an MCP or selected agent-framework adapter that remains a transport boundary.
8. Add additional action types only after the refund workflow is demonstrably stable.

Proposed files/components:

- Onboarding routes and UI within the future administrator application.
- Guided setup state for organizations, agents, policies, fact sources, providers, approvers, and activation.
- Proposed adapter packages under `packages/adapters/` after a framework decision.
- Onboarding, connection-test, credential-delivery, shadow-rollout, adapter-contract, and new-action security tests.

Expected behavior:

- An administrator can configure and test the complete authorization path before activating execution.
- Issued SDK credentials are scoped, expiring, revocable, and delivered without entering model prompts or source code.
- Adapters submit strict action requests but cannot authorize, evaluate policy, or call providers directly.

Acceptance criteria:

- Every onboarding step validates prerequisites and produces an auditable state change.
- Policy simulation and connector tests must pass before activation.
- Observation mode cannot execute actions, and enabling execution requires an explicit authorized transition.
- Any new action type has its own strict schema, policy tests, trusted facts, approval rules, connector restrictions, and failure analysis.

Verification steps:

- Run end-to-end onboarding in an isolated tenant from organization creation through shadow mode and controlled activation.
- Test abandoned/resumed setup, credential revocation, connector failure, unauthorized role changes, and cross-tenant isolation.
- Run adapter conformance tests proving no client-side authorization or provider bypass.
- Complete a security review before enabling each additional action type.

Limitations:

- Phase 10 does not promise arbitrary tools, generic natural-language policy, or unrestricted connectors.
- Public production rollout, multi-region operation, advanced analytics, and commercial packaging require separate decisions and hardening.
