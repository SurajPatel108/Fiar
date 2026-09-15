create table actions (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  principal_id text not null,
  policy_version_id text not null,
  order_fact_id text not null,
  order_fact_version text not null,
  business_facts jsonb not null,
  tool text not null check (tool = 'refund.create'),
  order_id text not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency in ('USD')),
  canonical_request jsonb not null,
  request_hash text not null,
  idempotency_key text not null,
  decision text not null check (decision in ('ALLOW', 'DENY', 'REQUIRE_APPROVAL')),
  decision_reason text not null,
  status text not null check (status in ('pending', 'denied', 'awaiting_approval', 'queued')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint actions_tenant_idempotency_key_key unique (tenant_id, idempotency_key),
  unique (id, tenant_id),
  foreign key (principal_id, tenant_id) references principals(id, tenant_id) on delete restrict,
  foreign key (policy_version_id, tenant_id) references policy_versions(id, tenant_id) on delete restrict,
  foreign key (order_fact_id, tenant_id) references order_facts(id, tenant_id) on delete restrict
);

create index actions_tenant_created_at_idx on actions (tenant_id, created_at desc, id desc);
create index actions_tenant_request_hash_idx on actions (tenant_id, request_hash);
create index actions_tenant_status_idx on actions (tenant_id, status);

create table pending_approval_requests (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  action_id text not null unique,
  policy_version_id text not null,
  request_hash text not null,
  status text not null check (status in ('pending')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, action_id),
  foreign key (action_id, tenant_id) references actions(id, tenant_id) on delete cascade,
  foreign key (policy_version_id, tenant_id) references policy_versions(id, tenant_id) on delete restrict
);

create function reject_action_content_update() returns trigger
language plpgsql
as $$
begin
  if row(
    new.tenant_id,
    new.principal_id,
    new.policy_version_id,
    new.order_fact_id,
    new.order_fact_version,
    new.business_facts,
    new.tool,
    new.order_id,
    new.amount_minor,
    new.currency,
    new.canonical_request,
    new.request_hash,
    new.idempotency_key,
    new.decision,
    new.decision_reason,
    new.created_at
  ) is distinct from row(
    old.tenant_id,
    old.principal_id,
    old.policy_version_id,
    old.order_fact_id,
    old.order_fact_version,
    old.business_facts,
    old.tool,
    old.order_id,
    old.amount_minor,
    old.currency,
    old.canonical_request,
    old.request_hash,
    old.idempotency_key,
    old.decision,
    old.decision_reason,
    old.created_at
  ) then
    raise exception 'action content is immutable' using errcode = '23000';
  end if;

  return new;
end;
$$;

create trigger actions_immutable_content
before update on actions
for each row execute function reject_action_content_update();
