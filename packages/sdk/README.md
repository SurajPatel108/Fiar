# Fiar TypeScript SDK

The SDK is a typed HTTP client for the Fiar gateway. It does not evaluate policy, access PostgreSQL, or call the worker/provider. Credentials are used only to construct request headers and are never logged or persisted by the SDK.

```ts
import { FiarClient } from '@fiar/sdk';

const credential = process.env.FIAR_AGENT_CREDENTIAL;
if (!credential) throw new Error('FIAR_AGENT_CREDENTIAL is required');

const fiar = new FiarClient({
  baseUrl: 'http://127.0.0.1:3000',
  workloadCredential: credential,
});

const action = await fiar.submitAction({
  tool: 'refund.create',
  orderId: 'ord_demo_threshold',
  amountMinor: 5000,
  currency: 'USD',
  idempotencyKey: crypto.randomUUID(),
});

console.log(action.actionId, action.status, action.approvalId);
```

Applications with another authentication scheme can supply `headers` or an asynchronous `getCredentialHeaders` callback instead. Never put credentials in source code.

`workloadCredential` sends `Authorization: Bearer …` and is the production agent/service option. The older `credential` plus optional `credentialHeader` behavior remains available for the explicit development adapter. The two options are mutually exclusive, and the SDK never stores, logs, validates, or authorizes either credential locally.
