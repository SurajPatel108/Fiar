create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table tenants (
  id text primary key,
  name text not null,
  status text not null check (status in ('active', 'suspended', 'deleted')),
  active_policy_version_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table principals (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  type text not null check (type in ('agent', 'manager', 'admin', 'service')),
  status text not null check (status in ('active', 'suspended', 'deleted')),
  external_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_subject),
  unique (id, tenant_id)
);

create table policy_versions (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  status text not null check (status in ('draft', 'published', 'retired')),
  ruleset jsonb not null,
  published_by text not null,
  published_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, version_number),
  unique (id, tenant_id),
  foreign key (published_by, tenant_id) references principals(id, tenant_id) on delete restrict
);

create table order_facts (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  external_order_id text not null,
  currency text not null check (currency in ('USD')),
  active boolean not null,
  refundable_remaining_minor bigint not null check (refundable_remaining_minor >= 0),
  previous_refund_total_minor bigint not null check (previous_refund_total_minor >= 0),
  order_exposure_minor bigint not null check (order_exposure_minor >= 0),
  budget_available_minor bigint not null check (budget_available_minor >= 0),
  status text not null check (status in ('open', 'partially_refunded', 'refunded', 'closed', 'disputed')),
  source_system text not null,
  source_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_order_id),
  unique (id, tenant_id)
);

alter table tenants
  add constraint tenants_active_policy_version_fkey
  foreign key (active_policy_version_id, id) references policy_versions(id, tenant_id) on delete restrict;

create function reject_published_policy_change() returns trigger
language plpgsql
as $$
begin
  if old.status = 'published' then
    raise exception 'published policy versions are immutable' using errcode = '23000';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger policy_versions_immutable_after_publish
before update or delete on policy_versions
for each row execute function reject_published_policy_change();
