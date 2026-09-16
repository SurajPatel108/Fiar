\set ON_ERROR_STOP on
do $$
begin
  if not exists (select 1 from schema_migrations where name = '0006_phase6_identity_and_operations.sql') then
    raise exception 'required Phase 6 migration is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'actions_tenant_idempotency_key_key') then
    raise exception 'action idempotency constraint is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workload_credentials_state_check') then
    raise exception 'credential state constraint is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'human_sessions_state_check') then
    raise exception 'session state constraint is missing';
  end if;
end $$;

select 'backup verification passed' as result;
