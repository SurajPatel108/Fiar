# Fiar Manager Dashboard

This is the manager client for the existing gateway approval APIs. It cannot execute refunds, call the provider, change policy, administer the kill switch, or bypass server-side authorization.

## Start

Start PostgreSQL, the gateway, and worker using the root README, then run:

```sh
npm run dev:dashboard
```

Open `http://127.0.0.1:5173`. Enter the local manager credential configured in the gateway's `FIAR_DEV_CREDENTIALS_JSON`. The credential remains only in React memory: it is not stored in localStorage, sessionStorage, cookies, or source code, and a reload clears it.

Vite proxies `/v1` to `http://127.0.0.1:3000`. To use another local gateway port:

```sh
FIAR_DASHBOARD_GATEWAY_URL=http://127.0.0.1:3100 npm run dev:dashboard
```

## Production session mode

The production build removes raw credential entry. It loads `GET /v1/auth/session`, redirects unauthenticated users through `/v1/auth/oidc/start`, uses the server-managed `HttpOnly` session cookie, and holds the returned CSRF token only in React memory. Decisions and logout send that token; tenant, role, approval binding, and authorization remain enforced by the gateway.

The dashboard must be served from the configured same origin through the supplied Nginx proxy. It never writes authentication material to localStorage or sessionStorage. A real OIDC client registration is required before pilot activation.

## Manual test

1. Submit a `refund.create` action for seeded order `ord_demo_threshold` with amount `5000` using an agent credential and a fresh idempotency key.
2. Open the dashboard with the matching tenant's manager credential.
3. Select the pending approval and verify its action, business context, request hash, policy version, and expiry.
4. Choose approve or reject, optionally add a comment, and confirm in the dialog.
5. Verify the success state and that the item leaves the pending queue. Approval only queues controlled worker work; it does not claim immediate provider execution.
The production manager flow is covered by `npm run test:e2e`. It builds this dashboard and drives it in Chromium through the real gateway and a deterministic local OIDC issuer; no frontend API mocking or external identity account is used.
