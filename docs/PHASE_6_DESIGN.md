# Phase 6 Security and Operations Design

## Status

Phase 6 is implemented and all repository-controlled acceptance checks pass. Controlled-pilot activation still requires an operator-selected OIDC registration, final HTTPS origin, and independently generated deployment secrets. The deterministic PostgreSQL fake provider remains the only execution provider and cannot move real money.

## Runtime and identity model

Every process requires `FIAR_RUNTIME_MODE=development|test|production`; missing or unknown values fail before listening. Development credentials are loaded only outside production. The Compose development override reads them from an ignored `.env.development.local` file created from `.env.development.example`. Production rejects both development credential configuration and the `x-fiar-dev-credential` request header.

Agents and services use opaque `fiar_<credential-id>_<random-secret>` bearer credentials. PostgreSQL stores the credential ID and an HMAC-SHA-256 verifier keyed by a mounted pepper, never the secret. Parsing is length/format bounded, comparison is timing-safe even for unknown IDs, and authentication rechecks credential state/expiry plus principal and tenant activity. Credentials grant identity only; server-derived role permissions still authorize actions.

Managers and admins use OIDC Authorization Code Flow with PKCE S256. Discovery, HTTPS endpoints in production, issuer, audience, signature, algorithm, expiry, nonce, state, and PKCE are validated. State is short-lived, one-use, and bound to an `HttpOnly` browser-flow cookie whose random value is stored only as a SHA-256 verifier. `(issuer, subject)` must already map to an active manager/admin principal; first-login privilege creation is forbidden. No username/password database or fake production login exists.

## Sessions and browser controls

OIDC callback creates a fresh opaque session. PostgreSQL stores only its HMAC verifier, tenant/principal binding, absolute expiry, idle expiry, activity, and revocation. The production cookie is `__Host-fiar_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and has no Domain. Defaults are a 30-minute idle limit and eight-hour absolute limit.

`GET /v1/auth/session` returns a 15-minute HMAC CSRF token bound to that session. The dashboard keeps it in React memory. Approval decisions and logout require the token, the exact configured Origin, and the configured Host. Logout revokes the database session and expires the cookie. No authentication material is placed in localStorage or sessionStorage.

## Credential and identity operations

Phase 6 intentionally exposes no administration API. An operator with database and secret access uses:

```sh
npm run credential:create -- --tenant TENANT_ID --principal PRINCIPAL_ID --expires-days 90
npm run credential:rotate -- --credential CREDENTIAL_ID --expires-days 90
npm run credential:revoke -- --credential CREDENTIAL_ID
npm run identity:map -- --issuer https://issuer.example --subject SUBJECT --tenant TENANT_ID --principal PRINCIPAL_ID
npm run session:revoke -- --session SESSION_ID
```

Creation/rotation prints a raw workload token once. Rotation creates the replacement and revokes the prior credential in one transaction. Commands refuse missing, deleted, suspended, cross-tenant, or role-incompatible principals.

## Secret model

Development/test may use `FIAR_SECRET_*` environment values. Production uses validated mounted files for the database URL, workload pepper, session pepper, CSRF key, OIDC state-encryption key, optional OIDC client secret, and metrics token. Files must be regular, bounded, and not group/world writable; required files must be nonempty, while a safe empty file explicitly represents an absent client secret for a public OIDC client. Values are never included in startup errors, health output, logs, or audits. A future Vault or cloud adapter can implement the same narrow `SecretProvider` interface.

## Audit and logs

Business and security audit writers accept per-event allowlisted payloads only. They reject secret-bearing keys/values, excessive nesting, all arrays, and payloads over 8 KiB. Authorization headers, cookies, session/CSRF values, OIDC codes/tokens, workload secrets/verifiers, peppers, client/provider secrets, and credential-bearing database URLs are forbidden. Authentication failures store only bounded categories. Operational logs use fixed safe fields and never serialize request/config/error objects.

## Health, readiness, and metrics

Gateway and worker expose `/health/live`, `/health/ready`, and `/metrics`. Liveness reports only that the process is running. Readiness uses short database/migration checks and reports safe component states; gateway production readiness also requires initialized OIDC. Worker readiness reports the deterministic fake connector as initialized. Dependency failure does not remove liveness.

Metrics require a separate bearer secret and are internal in Compose. Labels are fixed enums only; tenant/principal/action/order IDs, hashes, comments, credentials, and arbitrary errors are never labels. Metrics cover policy decisions, authentication successes/failures, OIDC, approval outcomes/conflicts, both idempotency layers, worker claims/retries/failures, execution/reconciliation outcomes, kill-switch blocks, component readiness, queue depth/age, pending approvals/age, and pending reconciliation count/age. Version-controlled alert rules and first-response guidance are in [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md). Counters and authentication throttling are process-local, appropriate only for the single-instance controlled pilot.

## Deployment and recovery

The three multi-stage images use Node 22 Alpine or Nginx 1.27 Alpine, reproducible `npm ci`, non-root users, minimal runtime artifacts, health checks, and no embedded secrets. The dashboard proxy applies CSP, frame denial, MIME-sniffing, and referrer protections. Compose supplies PostgreSQL, a one-shot migration job, gateway, worker, and dashboard on an internal service network. The gateway also has an outbound network for OIDC, and the dashboard alone joins a port-publishing network and exposes a host port in pilot mode; PostgreSQL, gateway, and worker remain unpublished.

Production services verify through migration `0007_phase6_acceptance.sql` rather than applying schema at startup. That forward migration adds the browser-flow binding to OIDC attempts. Development/test can migrate explicitly. Backup tooling creates a custom PostgreSQL dump and restores only into a validated `fiar_restore_*` database, checks migrations and critical constraints, and drops only that temporary database. It never drops `fiar` or deletes a volume.

Gateway shutdown stops accepting work and closes its pool. Worker shutdown stops new claims, allows the active operation a bounded completion window, and leaves any forced-stop lease/attempt durable for existing reconciliation.

## Failure behavior and limitations

Identity, required secrets, migration state, database access, OIDC validation, CSRF, and authorization fail closed. Generic client errors do not disclose which credential, mapping, session, or dependency failed. The fake provider, exact approval binding, idempotency, reservations, kill switch, and ambiguous-outcome reconciliation are unchanged.

Phase 6 does not implement a real provider, external fact connector, policy/admin control plane, public webhook, MCP adapter, new action type, multi-region operation, or Phases 7–10. A real OIDC registration and deployed-secret ceremony are still required before describing a pilot environment as activated.

## Acceptance commands

`npm run verify` passes 15 unit/security/policy tests, 47 gateway integration tests, 8 operator CLI tests, 11 dedicated shutdown tests, 21 worker tests (including worker shutdown coverage), 7 SDK tests, 3 dashboard component/API tests, and 20 Playwright browser/OIDC tests. `npm run verify:alerts` validates 13 rules with Prometheus 2.55.1. `npm run verify:containers` builds non-root production images and exercises an isolated production runtime with temporary file secrets, functional local fake OIDC, session-based manager endpoints, and agent access denial. The CI workflow runs these gates plus the guarded isolated backup/restore verification.

