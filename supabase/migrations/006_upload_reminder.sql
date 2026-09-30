-- ============================================================================
-- 006 — vangnet voor mislukte uploads (fix/durable-upload, NOG NIET TOEGEPAST)
-- ============================================================================
-- Incident 2026-09-28: opname 89119272-… (75 min, fysieke meeting) bleef op
-- pending_upload zonder bestand in storage. De nieuwe edge function
-- sweep-pending-uploads mailt het lid één keer (na 2 uur) en geeft na 7 dagen
-- op (status 'error'). upload_reminder_sent_at voorkomt dubbele mails.
alter table public.recordings
  add column if not exists upload_reminder_sent_at timestamptz;

comment on column public.recordings.upload_reminder_sent_at is
  'Tijdstip waarop sweep-pending-uploads het lid mailde dat het audiobestand nooit aankwam (max. één keer per opname).';

-- Partiële index: de sweep zoekt enkel in pending_upload.
create index if not exists recordings_pending_upload_idx
  on public.recordings (created_at) where status = 'pending_upload';

-- ----------------------------------------------------------------------------
-- Voorgestelde cron (elk uur, :40) — APART uitvoeren NA het deployen van de
-- function. Niet hardcoden: de bearer komt uit Vault.
--
-- Variant A (zoals gevraagd): service_role_key uit Vault. LET OP: op
-- plbuczbxtauhuobkicdr staat momenteel ENKEL 'cron_secret' in Vault; maak eerst
--   select vault.create_secret('<SERVICE-ROLE-KEY>', 'service_role_key');
-- aan (Dashboard → SQL, waarde zelf plakken).
--
-- select cron.schedule(
--   'sweep-pending-uploads-hourly',
--   '40 * * * *',
--   $$
--   select net.http_post(
--     url := 'https://plbuczbxtauhuobkicdr.supabase.co/functions/v1/sweep-pending-uploads',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
--       'Content-Type', 'application/json',
--       'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'), '')
--     ),
--     body := '{}'::jsonb
--   ) as request_id;
--   $$
-- );
--
-- Variant B (zelfde patroon als de bestaande jobs 4–9): publieke anon-JWT als
-- bearer + x-cron-secret uit Vault. Neem de Authorization-header letterlijk over
-- uit een bestaande job:  select command from cron.job where jobid = 7;
--
-- Eerste test zonder mails/wijzigingen (dry-run), bv. vanuit de SQL-editor:
--   select net.http_post(
--     url := 'https://plbuczbxtauhuobkicdr.supabase.co/functions/v1/sweep-pending-uploads',
--     headers := <zelfde headers als hierboven>,
--     body := '{"dry_run": true}'::jsonb);
--   -- resultaat: select * from net._http_response order by id desc limit 1;
-- ----------------------------------------------------------------------------
