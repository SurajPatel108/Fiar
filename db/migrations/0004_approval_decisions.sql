alter table actions
  drop constraint actions_status_check;

alter table actions
  add constraint actions_status_check
  check (status in ('pending', 'denied', 'awaiting_approval', 'queued', 'expired'));

alter table actions
  add constraint actions_approval_binding_key
  unique (id, tenant_id, policy_version_id, request_hash);

alter table pending_approval_requests
  drop constraint pending_approval_requests_status_check;

alter table pending_approval_requests
  add column manager_principal_id text null,
  add column decision text null,
  add column manager_comment text null,
  add column resolved_at timestamptz null,
  add column resolution_reason text null;

alter table pending_approval_requests
  add constraint pending_approval_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'expired')),
  add constraint pending_approval_requests_decision_check
  check (decision is null or decision in ('approve', 'reject')),
  add constraint pending_approval_requests_resolution_check
  check (
    (status = 'pending'
      and manager_principal_id is null
      and decision is null
      and manager_comment is null
      and resolved_at is null
      and resolution_reason is null)
    or
    (status = 'approved'
      and manager_principal_id is not null
      and decision = 'approve'
      and resolved_at is not null
      and resolution_reason is not null)
    or
    (status = 'rejected'
      and manager_principal_id is not null
      and decision = 'reject'
      and resolved_at is not null
      and resolution_reason is not null)
    or
    (status = 'expired'
      and manager_principal_id is null
      and decision is null
      and manager_comment is null
      and resolved_at is not null
      and resolution_reason is not null)
  ),
  add constraint pending_approval_requests_manager_tenant_fkey
  foreign key (manager_principal_id, tenant_id)
  references principals(id, tenant_id) on delete restrict,
  add constraint pending_approval_requests_exact_action_fkey
  foreign key (action_id, tenant_id, policy_version_id, request_hash)
  references actions(id, tenant_id, policy_version_id, request_hash) on delete cascade;

create index pending_approval_requests_tenant_status_created_idx
  on pending_approval_requests (tenant_id, status, created_at desc, id desc);
