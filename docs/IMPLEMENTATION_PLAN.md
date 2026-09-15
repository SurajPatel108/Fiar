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
- Record all blocked decisions in [docs/DECISIONS_AND_QUESTIONS.md](docs/DECISIONS_AND_QUESTIONS.md).

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
- apps/dashboard/src/main.tsx
- apps/dashboard/src/App.tsx
- apps/dashboard/src/api.ts
- apps/dashboard/src/routes/PendingApprovals.tsx
- apps/dashboard/src/routes/ApprovalDetail.tsx
- apps/dashboard/src/routes/CompletedActions.tsx
- apps/dashboard/src/routes/ExpiredApprovals.tsx
- apps/dashboard/src/components/ActionTable.tsx
- apps/dashboard/src/components/ApprovalPanel.tsx
- apps/dashboard/src/components/StatusBadge.tsx
- apps/dashboard/test/dashboard.test.tsx

Expected behavior:

- Manager decisions affect only the exact pending action.
- Changed or expired requests cannot reuse an old approval.
- Agent credentials are rejected by manager-only endpoints.

Acceptance criteria:

- Approving the same request twice does not enqueue another logical action.
- Rejected or expired approvals cannot be replayed.
- Editing the request creates a new action rather than mutating the approved one.

The approval path must read the published policy version active at action creation time and record that version on the approval row.

Verification steps:

- Approve the threshold fixture and confirm it moves forward once.
- Expire an approval and confirm the old decision is unusable.
- Call the approval endpoint with an agent credential and confirm authorization fails.

## Phase 4: Worker, outbox, and provider reconciliation

Goal: perform durable execution with idempotency, reservation safety, and crash recovery.

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

## Phase 5: SDK and manager UI integration

Goal: expose a usable client library and dashboard without weakening the server-side boundary.

Tasks:

1. Add the TypeScript SDK client and polling helpers.
2. Wire the dashboard to the gateway APIs.
3. Display actionable status, reasons, and policy versions.
4. Keep all credentials server-side or in authenticated dashboard sessions only.

Prerequisites:

- Phase 2 gateway APIs.
- Phase 3 approvals.

Files to create or change:

- packages/sdk/src/index.ts
- packages/sdk/src/client.ts
- packages/sdk/src/types.ts
- packages/sdk/src/actions.ts
- packages/sdk/src/polling.ts
- packages/sdk/test/sdk.test.ts

Expected behavior:

- The SDK submits a request and polls for the resulting state.
- The dashboard can show pending, completed, and expired work.

Acceptance criteria:

- SDK requests serialize exactly to the gateway schema.
- The dashboard reads only tenant-visible records.

Verification steps:

- Run SDK request serialization tests.
- Open the dashboard against seeded data and confirm the lists render.

## Phase 6: Production hardening

Goal: make the MVP resilient enough for a controlled pilot.

Tasks:

1. Add deployment packaging and local compose support.
2. Add health checks, backup checks, and recovery validation.
3. Add audit redaction enforcement.
4. Add metrics for denial rate, approval rate, duplicate prevention, and worker retries.
5. Add failure-mode tests for crash recovery, policy updates, and stale approvals.

Prerequisites:

- Phase 4 worker recovery.

Files to create or change:

- infra/docker/Dockerfile.gateway
- infra/docker/Dockerfile.worker
- infra/docker/Dockerfile.dashboard
- infra/compose/docker-compose.yml
- infra/sql/backup-check.sql
- infra/sql/health-check.sql

Expected behavior:

- The system fails closed when identity, policy, or audit storage is unavailable.
- Recovery behavior is measurable, not assumed.

Acceptance criteria:

- Backup restoration is tested.
- Audit output is redacted.
- Hardening checks do not change the authorization semantics.

Verification steps:

- Run backup and health checks.
- Review audit samples for secret leakage.
- Run failure injection tests for crash and timeout paths.
