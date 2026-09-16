create table workload_credentials (
  id text primary key,
  tenant_id text not null,
  principal_id text not null,
  credential_type text not null check (credential_type in ('agent', 'service')),
  verifier text not null check (verifier ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('active', 'revoked')),
  expires_at timestamptz not null,
  last_used_at timestamptz null,
  revoked_at timestamptz null,
  replacement_credential_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (id, tenant_id, principal_id),
  foreign key (principal_id, tenant_id) references principals(id, tenant_id) on delete restrict,
  constraint workload_credentials_state_check check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  ),
  constraint workload_credentials_expiry_check check (expires_at > created_at)
);

alter table workload_credentials
  add constraint workload_credentials_replacement_fkey
  foreign key (replacement_credential_id, tenant_id, principal_id)
  references workload_credentials(id, tenant_id, principal_id) on delete restrict;

create index workload_credentials_principal_status_idx
  on workload_credentials (tenant_id, principal_id, status, expires_at);

create table human_identity_mappings (
  id text primary key,
  issuer text not null,
  subject text not null,
  tenant_id text not null,
  principal_id text not null,
  status text not null check (status in ('active', 'revoked')),
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (issuer, subject),
  unique (id, tenant_id),
  foreign key (principal_id, tenant_id) references principals(id, tenant_id) on delete restrict,
  constraint human_identity_mappings_state_check check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create index human_identity_mappings_principal_idx
  on human_identity_mappings (tenant_id, principal_id, status);

create table oidc_login_attempts (
  id text primary key,
  state_verifier text not null unique check (state_verifier ~ '^[a-f0-9]{64}$'),
  nonce_verifier text not null check (nonce_verifier ~ '^[a-f0-9]{64}$'),
  pkce_verifier_ciphertext text not null,
  pkce_verifier_iv text not null,
  pkce_verifier_tag text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint oidc_login_attempts_expiry_check check (expires_at > created_at),
  constraint oidc_login_attempts_consumed_check check (consumed_at is null or consumed_at >= created_at)
);

create index oidc_login_attempts_expiry_idx on oidc_login_attempts (expires_at, consumed_at);

create table human_sessions (
  id text primary key,
  tenant_id text not null,
  principal_id text not null,
  token_verifier text not null check (token_verifier ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('active', 'revoked')),
  absolute_expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (principal_id, tenant_id) references principals(id, tenant_id) on delete restrict,
  constraint human_sessions_state_check check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  ),
  constraint human_sessions_expiry_check check (
    idle_expires_at > created_at and absolute_expires_at > created_at
    and idle_expires_at <= absolute_expires_at
  )
);

create index human_sessions_lookup_idx on human_sessions (id, status, idle_expires_at, absolute_expires_at);
create index human_sessions_principal_idx on human_sessions (tenant_id, principal_id, status);

create table security_audit_events (
  id text primary key,
  tenant_id text null,
  principal_id text null,
  event_type text not null check (event_type in (
    'authentication.failed', 'authentication.succeeded',
    'credential.created', 'credential.rotated', 'credential.revoked',
    'identity.mapped',
    'session.created', 'session.revoked', 'session.expired',
    'oidc.failed', 'oidc.succeeded'
  )),
  outcome text not null,
  reason text not null,
  redacted_payload jsonb not null,
  correlation_id text not null,
  created_at timestamptz not null default now(),
  constraint security_audit_principal_tenant_check check (principal_id is null or tenant_id is not null),
  foreign key (principal_id, tenant_id) references principals(id, tenant_id) on delete restrict
);

create index security_audit_events_created_idx on security_audit_events (created_at desc, id desc);
create index security_audit_events_tenant_created_idx
  on security_audit_events (tenant_id, created_at desc, id desc) where tenant_id is not null;
