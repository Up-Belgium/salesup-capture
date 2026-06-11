-- ============================================================================
-- Eerste organisatie + owner aanmaken (eenmalig, na het aanmaken van je eigen
-- auth-gebruiker via Dashboard → Authentication → Add user)
-- ============================================================================
-- Maakt de organisatie salesUp aan, koppelt jou als owner, en zet de
-- standaard-instellingen. Pas e-mail/naam aan waar nodig.

with org as (
  insert into organizations (name)
  values ('salesUp')
  returning id
), me as (
  select id as user_id, email from auth.users
  where email = 'stig.vh@salesup.be'
)
insert into members (org_id, user_id, email, full_name, role)
select org.id, me.user_id, me.email, 'Stig Vanhauwaert', 'owner'
from org, me;

insert into org_settings (org_id)
select id from organizations where name = 'salesUp'
on conflict (org_id) do nothing;

-- Optioneel — koppeling met het trainingsplatform (brug):
-- update organizations set training_client_id = '<clients.id uit trainingsproject>'
--   where name = 'salesUp';
-- update members set training_participant_id = '<training_participants.id>'
--   where email = 'stig.vh@salesup.be';

-- Optioneel — hardware-device registreren (token zelf kiezen, bv. 64 hex chars):
-- insert into devices (org_id, member_id, kind, name, token_hash)
-- select m.org_id, m.id, 'hardware', 'Plaud-prototype 1', encode(digest('<JOUW-DEVICE-TOKEN>', 'sha256'), 'hex')
-- from members m where m.email = 'stig.vh@salesup.be';
