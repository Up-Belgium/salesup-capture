-- ============================================================================
-- 007 — wachtruimte-melding (2026-10-13)
-- ============================================================================
-- Hoofdoorzaak van gemiste opnames: de bot "salesUp Capture" blijft in de
-- wachtruimte staan en wordt nooit toegelaten (op 13/10: 5 van 6 meetings).
-- poll-bots verwittigt het lid nu één keer (push, anders mail) zodra de bot in
-- de wachtruimte staat; deze kolom voorkomt herhaling.
alter table public.recordings
  add column if not exists waiting_room_notified_at timestamptz;

comment on column public.recordings.waiting_room_notified_at is
  'Tijdstip waarop poll-bots het lid verwittigde dat de bot in de wachtruimte stond (max. één keer per opname).';
