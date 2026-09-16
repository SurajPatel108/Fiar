# Decisions and Questions

## Confirmed requirements from the paper

- The first real workflow is refund authorization.
- The gateway must enforce authorization independently of the agent prompt.
- Approval must be immutable and tied to the exact request.
- Execution must be durable and idempotent.
- Credentials must stay outside the agent.
- Suspension and policy updates must invalidate stale authority.

## Recommended decisions

### Use TypeScript everywhere

Reasoning:

- The paper’s proposed stack already assumes TypeScript.
- Shared types reduce drift between SDK, gateway, worker, and dashboard.

Tradeoff:

- Requires stricter schema discipline up front.

### Keep the first workflow to one refund tool

Reasoning:

- The paper’s narrow refund example is enough to prove the authorization firewall.
- More tools would obscure the core state machine.

Tradeoff:

- Broader generality waits until the refund path is stable.

### Derive tenant identity server-side

Reasoning:

- Prevents tenant spoofing through request fields.

Tradeoff:

- Requires a real authentication integration early.

### Treat approvals as exact request bindings

Reasoning:

- Prevents the common bug where a manager approves a mutated payload.

Tradeoff:

- More rejections when a request changes, but those rejections are correct.

### Keep provider credentials only in gateway/worker infrastructure

Reasoning:

- The agent should never be able to bypass the firewall by calling the provider directly.

Tradeoff:

- Requires careful secret management and a narrower connector boundary.

### Use a durable outbox and worker reconciliation

Reasoning:

- This is the safest way to handle crashes, retries, and ambiguous provider outcomes.

Tradeoff:

- More moving parts than a direct synchronous provider call.

### Fail closed when identity, policy, or audit storage is unavailable

Reasoning:

- The paper explicitly recommends failing closed for writes in those conditions.

Tradeoff:

- Temporary unavailability is preferable to unsafe authorization.

## Assumptions

- The initial tenant model can be single-organization per deployment for the MVP, as long as tenant isolation is still enforced in the schema and APIs.
- The manager workflow can start with approve/reject and no inline amount edits.
- The SDK can poll status instead of requiring webhooks.
- The first provider can be a mock or sandbox connector.
- Audit retention can start short and be extended later.

## Phase 2 decisions

1. Local development uses an explicitly development-only environment credential directory mapping opaque tokens to server-side principal records. Production identity remains a future hardening decision.
2. The refund canonical hash covers `tool`, `orderId`, `amountMinor`, and `currency`; it deliberately excludes the idempotency key.
3. Pending approvals default to 24 hours and are configurable with `FIAR_APPROVAL_EXPIRY_HOURS`.
4. Policy denial is returned and durably recorded as a normal action response. Malformed, unauthenticated, forbidden, missing-fact, and conflicting requests use HTTP errors.

## Phase 3 decisions

1. Only active managers and admins may read or decide approvals; agents and services are forbidden.
2. Manager approval atomically moves an action from `awaiting_approval` to `queued`; manager rejection moves it to `denied`.
3. Expired, policy-stale, or requester-suspended approvals are durably resolved as `expired` on manager reads or decision attempts.
4. Approval requests use the displayed request hash and policy version ID as optimistic exact-binding checks.
5. Phase 5 added a local-only Vite/React dashboard; Phase 6 retains that development mode and adds the production OIDC/session path.

## Phase 4 decisions

1. The only implemented provider is a deterministic fake backed by a PostgreSQL side-effect ledger; no production or network connector is configured.
2. Provider idempotency keys are stable `refund:<actionId>` values and are reused for safe retries and reconciliation.
3. Retryable failures are limited to failures known to occur before a provider result; ambiguous outcomes always require lookup reconciliation.
4. A tenant kill switch blocks new claims from crossing the provider boundary but does not discard already in-flight outcomes.
5. Order and budget capacity are reserved transactionally before dispatch, retained during ambiguity, consumed on success, and released after confirmed non-execution or failure.
6. Multiple partial refunds are allowed when authoritative remaining balance, aggregate exposure, budget, and threshold rules permit them. `previous_refund_total_minor` records confirmed execution history; it is not a standalone denial condition.

## Future roadmap decisions

1. Phase 6 hardens operations and identity but does not add a real provider.
2. Administrative policy control, trusted fact connectors, provider sandbox execution, and onboarding are separated into Phases 7, 8, 9, and 10 so convenience work cannot bypass prerequisite security boundaries.
3. The future `FactResolver` must fail closed for missing or stale decisive facts and must not accept agent assertions as authoritative replacements.
4. The deterministic fake provider remains the test default even after a sandbox connector is selected.

## Phase 6 decisions

1. Runtime mode is mandatory. Production rejects development credential configuration and headers rather than treating them as a fallback.
2. Agents/services use opaque bearer credentials with keyed HMAC-SHA-256 verifiers; raw secrets are returned once by an operator CLI and never stored.
3. Managers/admins use generic OIDC Authorization Code + PKCE mapped to existing principals. Fiar does not create privileged users on first login and does not maintain passwords.
4. Browser sessions are opaque, PostgreSQL-backed, idle/absolute-expiring, revocable, and bound to strict cookies plus HMAC CSRF and same-origin checks.
5. Production secrets use mounted files through a provider-neutral interface. No cloud-specific secret manager is claimed.
6. Authentication throttles and counters are process-local for the single-instance pilot; distributed enforcement remains a later scaling concern.
7. The deterministic PostgreSQL fake connector is permitted in the production runtime profile solely for a no-money controlled pilot.
8. Production processes verify schema state; a one-shot migration job applies forward migrations.
9. A selected/registered external OIDC client, exact HTTPS origin, and installed deployment secrets are blockers to pilot activation, not blockers to locally verifying the provider-neutral implementation.

## Questions that block later phases

1. Which OIDC issuer/client registration and final HTTPS callback origin will activate the controlled pilot?
2. What should happen to queued work when a tenant is suspended: keep, cancel, or reconcile to terminal failure?
3. Which refund-provider sandbox should Phase 9 target, and what idempotency, lookup, webhook, credential-scope, rate-limit, and failure-injection guarantees does it provide?

## Questions that can wait

1. Public webhooks.
2. MCP adapter support.
3. Multi-environment pricing tiers.
4. Multi-region deployment.
5. Advanced analytics and dashboards.
6. Automated policy suggestion tooling.

## Missing requirements and contradictions in the paper

- The paper describes both a learning prototype and a production architecture, but the transition point between them is not fully specified.
- It implies hard denials before approval, but some API examples still need a final choice between structured denial responses and HTTP errors.
- It mentions order exposure and budget reservations, but the precise reservation semantics and release rules are not fully defined.
- It refers to a policy version, but does not fully specify how policy publication affects pending approvals.
- It says the worker should reconcile ambiguous outcomes, but does not define the exact terminal states for unknown provider responses.
- It proposes an MCP adapter later, but the boundary between MCP authorization and business authorization needs to stay explicit so transport auth is not mistaken for workflow authorization.

## MVP exclusions

These are intentionally outside the first implementation phase:

- Public webhooks.
- Multiple tools beyond refunds.
- Production pricing packaging.
- Broad enterprise IAM integrations.
- Complex policy authoring UI.
- Full commercial rollout commitments.
