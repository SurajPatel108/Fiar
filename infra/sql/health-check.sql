\set ON_ERROR_STOP on
select case when exists (
  select 1 from schema_migrations where name = '0006_phase6_identity_and_operations.sql'
) then 'ready' else 'migration_missing' end as migration_status;

select
  (select count(*) from tenants) as tenants,
  (select count(*) from principals) as principals,
  (select count(*) from actions) as actions,
  (select count(*) from audit_events) as business_audit_events;
