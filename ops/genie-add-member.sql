-- Create the account first in Supabase Authentication -> Users, then replace
-- <uuid> with its User ID. Run after genie-access.sql creates the unique index.
-- Dollar quoting keeps apostrophes in names from breaking the SQL string.
insert into public.app_admins (user_id, display_name, active)
values ('<uuid>'::uuid, $name$王小明$name$, true)
on conflict (user_id) do update
  set display_name = excluded.display_name;

-- Explicitly reactivate an existing member (run separately when intended):
-- update public.app_admins set active = true where user_id = '<uuid>'::uuid;

-- Disable a member (run separately when intended):
-- update public.app_admins set active = false where user_id = '<uuid>'::uuid;
