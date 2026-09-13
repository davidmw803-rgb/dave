-- ============================================================================
-- Application settings — API keys and endpoints entered through /settings
-- instead of environment variables.
--
-- Secret values are stored AES-256-GCM encrypted (see lib/settings/crypto.ts);
-- `hint` keeps the last 4 characters so the UI can show which key is loaded
-- without ever decrypting for the browser. Reads and writes go through the
-- service-role client only — never expose this table to the anon key.
-- ============================================================================

create table if not exists app_settings (
  key text primary key,
  value text,                                  -- ciphertext when is_secret, plaintext otherwise
  is_secret boolean not null default true,
  hint text,                                   -- last 4 chars of a secret, for display
  updated_at timestamptz not null default now()
);

alter table app_settings enable row level security;
-- No policies: the anon and authenticated roles get nothing. The service-role
-- key bypasses RLS, which is the only way the app touches this table.

-- Defined in 001; repeated here so this migration also applies to a database
-- that doesn't have it yet.
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_app_settings_updated_at on app_settings;
create trigger trg_app_settings_updated_at
  before update on app_settings
  for each row execute function set_updated_at();
