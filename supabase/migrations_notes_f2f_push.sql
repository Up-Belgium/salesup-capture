-- F2F-push (toegepast 2026-06-26 op plbuczbxtauhuobkicdr)
alter table public.members add column if not exists expo_push_token text;
create table if not exists public.meeting_push_log (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  event_id text not null, meeting_start timestamptz,
  sent_at timestamptz not null default now(), push_status text,
  unique (member_id, event_id)
);
create index if not exists idx_meeting_push_log_member on public.meeting_push_log (member_id, sent_at desc);
alter table public.meeting_push_log enable row level security;
