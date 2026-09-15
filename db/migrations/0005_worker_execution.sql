alter table tenants
  add column execution_kill_switch_enabled boolean not null default false,
  add column execution_kill_switch_reason text null,
  add column execution_kill_switch_updated_at timestamptz null;

alter table actions
  drop constraint actions_status_check;

alter table actions
  add constraint actions_status_check
  check (status in (
    'pending', 'denied', 'awaiting_approval', 'queued', 'dispatched',
    'pending_reconciliation', 'completed', 'failed', 'expired', 'suspended'
  ));

alter table outbox_entries
  drop constraint outbox_entries_status_check;

alter table outbox_entries
  add column next_attempt_at timestamptz null,
  add column completed_at timestamptz null,
  add constraint outbox_entries_status_check
  check (status in (
    'ready', 'processing', 'completed', 'retryable_failure',
    'pending_reconciliation', 'failed', 'leased', 'dispatched'
  )),
  add constraint outbox_entries_id_tenant_key unique (id, tenant_id);

create table execution_reservations (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  action_id text not null unique,
  order_fact_id text not null,
  amount_minor bigint not null check (amount_minor > 0),
  status text not null check (status in ('reserved', 'consumed', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (action_id, tenant_id) references actions(id, tenant_id) on delete cascade,
  foreign key (order_fact_id, tenant_id) references order_facts(id, tenant_id) on delete restrict
);

create table execution_attempts (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  action_id text not null,
  outbox_entry_id text not null,
  attempt_number integer not null check (attempt_number > 0),
  provider_name text not null,
  provider_idempotency_key text not null,
  provider_request_id text null,
  status text not null check (status in (
    'started', 'succeeded', 'confirmed_failure', 'retryable_failure',
    'pending_reconciliation', 'reconciled_succeeded',
    'reconciled_not_executed', 'reconciled_failure'
  )),
  error_classification text null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  updated_at timestamptz not null default now(),
  unique (outbox_entry_id, attempt_number),
  foreign key (action_id, tenant_id) references actions(id, tenant_id) on delete cascade,
  foreign key (outbox_entry_id, tenant_id) references outbox_entries(id, tenant_id) on delete cascade
);

create index execution_attempts_reconciliation_idx
  on execution_attempts (tenant_id, status, updated_at, id);

create table fake_provider_refunds (
  provider_idempotency_key text primary key,
  provider_request_id text not null unique,
  action_id text not null,
  tenant_id text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency = 'USD'),
  status text not null check (status in ('succeeded', 'failed', 'unknown')),
  error_classification text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index outbox_entries_worker_claim_idx
  on outbox_entries (status, next_attempt_at, lease_expires_at, created_at, id);
