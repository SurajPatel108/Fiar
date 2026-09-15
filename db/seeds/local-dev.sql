insert into tenants (id, name, status)
values
  ('ten_demo_alpha', 'Demo Alpha', 'active'),
  ('ten_demo_beta', 'Demo Beta', 'active')
on conflict (id) do update set
  name = excluded.name,
  status = excluded.status,
  updated_at = now();

insert into principals (id, tenant_id, type, status, external_subject)
values
  ('prn_demo_alpha_agent', 'ten_demo_alpha', 'agent', 'active', 'dev-agent-alpha'),
  ('prn_demo_alpha_manager', 'ten_demo_alpha', 'manager', 'active', 'dev-manager-alpha'),
  ('prn_demo_alpha_admin', 'ten_demo_alpha', 'admin', 'active', 'dev-admin-alpha'),
  ('prn_demo_alpha_service', 'ten_demo_alpha', 'service', 'active', 'dev-service-alpha'),
  ('prn_demo_beta_agent', 'ten_demo_beta', 'agent', 'active', 'dev-agent-beta'),
  ('prn_demo_beta_manager', 'ten_demo_beta', 'manager', 'active', 'dev-manager-beta')
on conflict (id) do update set
  tenant_id = excluded.tenant_id,
  type = excluded.type,
  status = excluded.status,
  external_subject = excluded.external_subject,
  updated_at = now();

insert into policy_versions (id, tenant_id, version_number, status, ruleset, published_by, published_at)
values
  ('pol_demo_alpha_v1', 'ten_demo_alpha', 1, 'published', '{"workflow":"refund.create","approvalThresholdMinor":5000}'::jsonb, 'prn_demo_alpha_manager', now()),
  ('pol_demo_beta_v1', 'ten_demo_beta', 1, 'published', '{"workflow":"refund.create","approvalThresholdMinor":5000}'::jsonb, 'prn_demo_beta_manager', now())
on conflict (id) do nothing;

update tenants
set active_policy_version_id = case id
  when 'ten_demo_alpha' then 'pol_demo_alpha_v1'
  when 'ten_demo_beta' then 'pol_demo_beta_v1'
end,
updated_at = now()
where id in ('ten_demo_alpha', 'ten_demo_beta');

insert into order_facts (
  id,
  tenant_id,
  external_order_id,
  currency,
  active,
  refundable_remaining_minor,
  previous_refund_total_minor,
  order_exposure_minor,
  budget_available_minor,
  status,
  source_system,
  source_version
)
values
  ('ord_fact_demo_small', 'ten_demo_alpha', 'ord_demo_small', 'USD', true, 20000, 0, 0, 50000, 'open', 'seed', 'v1'),
  ('ord_fact_demo_threshold', 'ten_demo_alpha', 'ord_demo_threshold', 'USD', true, 20000, 100, 100, 50000, 'open', 'seed', 'v1'),
  ('ord_fact_demo_denied', 'ten_demo_alpha', 'ord_demo_denied', 'USD', true, 1000, 0, 0, 50000, 'open', 'seed', 'v1'),
  ('ord_fact_beta_small', 'ten_demo_beta', 'ord_beta_small', 'USD', true, 20000, 0, 0, 50000, 'open', 'seed', 'v1')
on conflict (id) do update set
  tenant_id = excluded.tenant_id,
  external_order_id = excluded.external_order_id,
  currency = excluded.currency,
  active = excluded.active,
  refundable_remaining_minor = excluded.refundable_remaining_minor,
  previous_refund_total_minor = excluded.previous_refund_total_minor,
  order_exposure_minor = excluded.order_exposure_minor,
  budget_available_minor = excluded.budget_available_minor,
  status = excluded.status,
  source_system = excluded.source_system,
  source_version = excluded.source_version,
  updated_at = now();
