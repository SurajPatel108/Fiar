create table outbox_entries (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  action_id text not null unique,
  kind text not null check (kind in ('refund.execute')),
  payload jsonb not null,
  status text not null check (status in ('ready', 'leased', 'dispatched', 'failed')),
  lease_owner text null,
  lease_expires_at timestamptz null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, action_id),
  foreign key (action_id, tenant_id) references actions(id, tenant_id) on delete cascade
);

create index outbox_entries_status_idx on outbox_entries (tenant_id, status, created_at asc, id asc);

create table audit_events (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  action_id text not null,
  event_type text not null,
  actor_type text not null,
  request_hash text not null,
  decision text not null,
  reason text not null,
  redacted_payload jsonb not null,
  correlation_id text not null,
  created_at timestamptz not null default now(),
  foreign key (action_id, tenant_id) references actions(id, tenant_id) on delete cascade
);

create index audit_events_tenant_created_at_idx on audit_events (tenant_id, created_at desc, id desc);
