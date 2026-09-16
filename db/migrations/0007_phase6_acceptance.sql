-- Login attempts are deliberately ephemeral. Existing pre-acceptance attempts are
-- invalidated so every new flow is bound to the browser that initiated it.
delete from oidc_login_attempts;

alter table oidc_login_attempts
  add column browser_binding_verifier text not null
  check (browser_binding_verifier ~ '^[a-f0-9]{64}$');

create index oidc_login_attempts_browser_binding_idx
  on oidc_login_attempts (state_verifier, browser_binding_verifier, expires_at)
  where consumed_at is null;
