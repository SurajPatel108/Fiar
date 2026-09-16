# Security and Testing

## Threat model

The attacker may be:

- A malicious or confused agent prompt.
- A compromised SDK caller.
- A cross-tenant caller with valid authentication for a different tenant.
- A manager trying to approve a mutated request.
- A worker crash, retry storm, or ambiguous provider response.
- A provider failure or maliciously inconsistent provider API.

The system must assume the request payload is untrusted, the agent is untrusted, and provider success/failure may be ambiguous.

## Security invariants

### Tenant isolation

An authenticated principal can only create, read, approve, or execute actions within its own tenant.

Tests:

- Create an action in tenant A and attempt to fetch it from tenant B.
- Attempt to approve an action from a different tenant.
- Attempt to list pending approvals across tenants.

Expected outcome:

- All cross-tenant attempts fail closed without revealing the target record.

### Default denial

Missing facts, missing authorization, unknown tools, invalid amounts, or malformed requests must deny by default.

Tests:

- Omit the authorization header.
- Send an unknown tool.
- Send a negative, fractional, or non-integer amount.
- Send an unsupported currency.

Expected outcome:

- The gateway rejects the request before any provider call or approval creation.

### Order activity and principal suspension

The authoritative `orderActive` fact describes the order, while principal and tenant activity come from authenticated server-side records. These signals must not share a reason code or substitute for one another.

Tests:

- Evaluate an inactive order and expect `ORDER_NOT_ACTIVE`.
- Suspend an agent or tenant and attempt action intake.
- Suspend an agent or tenant after queueing and attempt worker dispatch.

Expected outcome:

- Inactive orders are denied by policy; suspended principals and tenants are rejected by authentication/intake and worker revalidation.

### Aggregate limits

Concurrent requests must respect tenant and order limits even when they race.

Tests:

- Submit two concurrent refunds that together exceed the remaining budget.
- Submit two split refunds that individually fit but jointly exceed the threshold.

Expected outcome:

- At most one request reserves capacity and advances.
- A legitimate additional partial refund may advance when remaining balance, aggregate exposure, and budget permit it.

### Approval expiry

An approval must stop being usable after expiry.

Tests:

- Approve a request, wait for expiry, then attempt to reuse it.
- Publish a new policy version and attempt to reuse an older approval.

Expected outcome:

- The old approval is rejected as stale or invalid.

### Request binding

Approval is valid only for the exact canonical request, tenant, role, and policy version.

Tests:

- Change the amount after approval is requested.
- Change the destination/order reference.
- Attempt to approve with an agent credential.

Expected outcome:

- Any change invalidates the pending approval.

### Idempotency

Repeated requests with the same key and same canonical hash must resolve to one action.

Tests:

- Submit the same action twice.
- Restart the server and submit it again.
- Reuse the key with a different request body.

Expected outcome:

- Same hash returns the original action.
- Different hash returns a conflict.

### Concurrency safety

State transitions must remain correct under competing requests and worker races.

Tests:

- Race two create requests for the last available amount.
- Race two approval decisions.
- Race multiple workers against the same outbox row.

Expected outcome:

- Only one logical transition succeeds.

### Crash recovery

A worker crash after provider success but before local completion must not duplicate the provider side effect.

Tests:

- Inject a crash after the connector reports success.
- Restart the worker and reconcile the same idempotency key.

Expected outcome:

- The provider ledger contains one effect, and the local record converges to a single terminal state.

### Ambiguous provider outcomes

If the provider response is unknown, the system must not guess.

Tests:

- Simulate timeout after dispatch.
- Simulate lost response after the provider likely executed.

Expected outcome:

- The action is marked as `pending_reconciliation` or equivalent, not as failed or safe to replay blindly.

### Audit redaction

Audit logs must not expose provider secrets, raw auth tokens, or sensitive payloads beyond what is necessary for review.

Tests:

- Emit an audit event containing a mock secret field.
- Inspect redacted logs and stored events.

Expected outcome:

- The secret is removed or masked.

### Kill-switch limitations

Suspension must prevent new dispatch authorization, but it cannot retroactively undo already committed provider side effects.

Tests:

- Suspend a tenant with a queued action.
- Suspend an agent while a worker has already dispatched.

Expected outcome:

- New dispatch stops after suspension commits.
- In-flight provider effects remain separately tracked until reconciliation completes.

## Test map

| Invariant | Unit tests | Integration tests | Failure injection |
| --- | --- | --- | --- |
| Tenant isolation | tenant-scoped authorization helpers | action fetch/list by tenant | wrong-tenant replay |
| Default denial | policy boundary tests | gateway validation tests | malformed input corpus |
| Order/principal activity separation | policy reason tests | suspended intake tests | suspension before dispatch |
| Aggregate limits | reservation math tests | concurrent action creation | parallel refund race |
| Approval expiry | expiry helper tests | approval endpoint tests | policy publish while pending |
| Request binding | canonical hash tests | approval decision tests | request mutation after approval |
| Idempotency | canonical request tests | duplicate POST /v1/actions | server restart replay |
| Concurrency safety | lock and transition tests | outbox worker tests | double-worker claim |
| Crash recovery | reconciliation tests | worker restart tests | crash after provider success |
| Ambiguous outcomes | reconciliation state tests | provider timeout tests | lost response simulation |
| Audit redaction | audit sanitizer tests | event storage tests | secret-in-payload checks |
| Kill-switch limits | suspension state tests | queued work suspension tests | suspend after dispatch |
| Runtime/auth separation | mode/config tests | production dev-header and workload tests | missing/revoked/expired authority |
| Human sessions | CSRF/HMAC tests | OIDC, cookie, logout, expiry, role tests | replay and cross-session CSRF |
| Operational safety | secret/audit/metric tests | live/ready/metrics tests | dependency and shutdown failures |

Phases 2 through 4 verify tenant-scoped action and approval APIs, default denial, immutable request binding, concurrent idempotency and manager decisions, worker leasing, capacity reservations, provider idempotency, crash recovery, ambiguous-outcome reconciliation, kill-switch races, suspension/policy rechecks, transaction rollback, pagination validation, and audit redaction against real PostgreSQL. Phase 6 adds production-mode isolation, HMAC workload credentials, generic OIDC/PKCE, managed sessions, CSRF, mounted secrets, audit allowlists, health/readiness, protected metrics, packaging, and isolated restore verification. Real-provider validation remains later work.

## Required test fixtures

- A $49 allowed refund.
- A $50 refund that requires approval.
- A denied destination or tool mismatch.
- Two concurrent refunds competing for the last available budget.
- A crash immediately after provider success.
- A stale approval after policy change.
- An unknown provider timeout that must not auto-retry without reconciliation.

## Phase 5 client verification

The Phase 5 SDK and dashboard remain untrusted clients. SDK tests verify exact request serialization, workload bearer and caller-provided headers, bound approval fields, and typed failure handling. Dashboard tests verify complete cursor traversal and stale decision messaging in addition to strict typechecking and a production build. Development credentials remain only in page memory; the production build uses the Phase 6 server session and CSRF flow. Browser session protocol tests run at the gateway boundary; full browser automation against a selected external IdP remains part of pilot activation.

## Phase 6 security verification

Phase 6 tests reject development credentials in production; cover valid, malformed, unknown, expired, revoked, rotated, and suspended workload authority; exercise OIDC discovery/PKCE/JWKS/issuer/audience/signature/nonce/state behavior; verify session, CSRF, cookie, logout, and role boundaries; validate mounted-secret errors and audit redaction; and test safe health and metrics behavior. Container, Compose, hygiene, and isolated restore checks are separate verification gates. A real OIDC registration is still required before pilot activation.

## Future-phase security verification (not implemented)

Phases 7–10 add administrative authorization and policy simulation, trusted-fact provenance/freshness checks, sandbox-provider reconciliation and shutdown tests, and onboarding/shadow-mode validation. These future checks do not imply that generic policy authoring, external fact connectors, or a real provider exist today.

## Non-goals for testing the MVP

- Live production provider calls.
- Public webhooks.
- Multi-region failover.
- Sophisticated anomaly detection.
