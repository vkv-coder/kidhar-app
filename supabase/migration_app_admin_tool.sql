-- ==========================================
-- STAFFTRACK (Kidhar) - app-admin session tokens, backing the new
-- app-admin.html PIN-gated tool. Same shape as SEATBOOK's kh_admin_tokens
-- (PIN checked server-side in an Edge Function using service_role, issues
-- a short-lived opaque token, every subsequent call re-verifies the
-- token server-side) - never grant this table to anon/authenticated,
-- the Edge Function is the only thing that ever touches it.
-- ==========================================

create table if not exists stf_app_admin_tokens (
  token text primary key,
  expires_at timestamptz not null
);

revoke all on stf_app_admin_tokens from anon, authenticated;
