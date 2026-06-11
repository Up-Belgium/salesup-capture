-- 002 — RLS-helpers afschermen voor anon (gerund op live 2026-06-11).
-- authenticated houdt execute: de RLS-policies zelf draaien als die rol.
revoke execute on function is_org_member(uuid)  from public, anon;
revoke execute on function is_org_admin(uuid)   from public, anon;
revoke execute on function is_own_member(uuid)  from public, anon;
grant execute on function is_org_member(uuid)  to authenticated, service_role;
grant execute on function is_org_admin(uuid)   to authenticated, service_role;
grant execute on function is_own_member(uuid)  to authenticated, service_role;
