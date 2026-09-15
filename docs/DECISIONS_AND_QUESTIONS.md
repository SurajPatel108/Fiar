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

## Questions that block later phases

1. What should happen to queued work when a tenant is suspended: keep, cancel, or reconcile to terminal failure?
2. Which provider sandbox or mock contract should the worker target first?

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
