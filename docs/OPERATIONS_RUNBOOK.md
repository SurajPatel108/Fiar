# Phase 6 Operations Runbook

The Phase 6 pilot uses bounded, process-local metrics. Alerts never carry tenant, principal, order, action, URL, or request identifiers.

## Readiness

`FiarComponentNotReady` means a database, authentication, or connector readiness gauge has remained zero for five minutes. Check `/health/ready`, then inspect the named component. Re-run the one-shot migration job for a schema mismatch; validate mounted secret files and OIDC discovery for authentication failures.

## Authentication

`FiarAuthenticationFailureSpike` indicates sustained invalid, malformed, expired, or revoked authentication. First confirm OIDC availability and credential expiry. If abuse is suspected, use `npm run credential:revoke` or `npm run session:revoke`; do not expose credential material in incident notes.

## Approvals

`FiarApprovalExpiryOrConflictSpike` means approvals are expiring, becoming policy-stale, or receiving conflicting decisions. Confirm manager access, requester activity, policy version stability, and system time. Never override the exact request-hash/policy-version binding.

## Queue

`FiarQueueBacklog` means queue depth exceeds 100 or the oldest ready item is older than five minutes. Check worker readiness and the kill switch, then restart the worker gracefully. Durable queue entries remain in PostgreSQL.

## Reconciliation

`FiarReconciliationBacklog` means more than 20 uncertain executions are pending or the oldest is over 15 minutes old. Keep the worker running and inspect fake-provider ledger consistency. Do not manually mark ambiguous work successful.

## Worker

`FiarWorkerFailureSpike` signals repeated pre-provider retries or connector failures. Check database and connector readiness and allow normal bounded retries/reconciliation. A graceful restart leaves durable leases for normal recovery.

## Connector

`FiarConnectorNotReady` means the worker's deterministic fake connector failed initialization. The pilot has no network payment connector; verify schema/migration state and restart the worker. Do not add real provider credentials.
