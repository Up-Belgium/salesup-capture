-- ============================================================================
-- Vault-secret voor de cron-jobs (eenmalig, in Supabase Studio → SQL editor
-- van het project salesup-capture)
-- ============================================================================
-- De drie cron-jobs (transcribe / summarize-email / bridge) roepen de edge
-- functions aan met de service-role key uit de vault. Zonder dit secret loggen
-- de jobs een fout en gebeurt er niets.
--
-- 1. Kopieer de service_role key: Dashboard → Project Settings → API keys
-- 2. Vervang hieronder en voer uit:

select vault.create_secret('<PLAK-HIER-DE-SERVICE-ROLE-KEY>', 'service_role_key');

-- Controle:
-- select name, created_at from vault.secrets;
