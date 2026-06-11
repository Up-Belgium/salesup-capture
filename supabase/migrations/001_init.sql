-- ============================================================================
-- salesUp Capture — 001 init (standalone Supabase-project)
-- ============================================================================
-- Eigen multi-tenant model (organizations/members op Supabase Auth), los van
-- het trainingsplatform. De koppeling met training gebeurt via de optionele
-- mapping-kolommen (training_client_id / training_participant_id) en de
-- edge function bridge-to-training.
--
-- Pipeline: recordings → transcripts (Deepgram) → summaries (Claude + mail)
--                                            └→ bridge naar trainingsplatform
-- ============================================================================

begin;

-- 1 · Tenancy
create table organizations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  training_client_id  uuid,          -- clients.id in het trainingsproject (brug)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table members (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references organizations(id) on delete cascade,
  user_id                  uuid not null references auth.users(id) on delete cascade,
  email                    text not null,
  full_name                text,
  role                     text not null default 'member' check (role in ('owner','admin','member')),
  training_participant_id  uuid,    -- training_participants.id in het trainingsproject (brug)
  receive_email_summary    boolean not null default true,
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (org_id, user_id)
);

create index members_user_idx on members (user_id);

-- 2 · Capture-bronnen (apps + hardware-devices)
create table devices (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  member_id     uuid references members(id) on delete set null,
  kind          text not null check (kind in ('mobile','desktop','hardware','integration')),
  name          text,
  platform      text,
  token_hash    text unique,   -- sha256(device-token); alleen hardware/integraties
  is_active     boolean not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index devices_org_idx on devices (org_id);

-- 3 · Opnames
create table recordings (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id) on delete cascade,
  member_id             uuid references members(id) on delete set null,
  device_id             uuid references devices(id) on delete set null,
  recording_type        text not null check (recording_type in ('video_meeting','in_person','phone')),
  meeting_platform      text,
  title                 text,
  started_at            timestamptz not null,
  ended_at              timestamptz,
  duration_seconds      integer,
  storage_path          text,
  status                text not null default 'pending_upload' check (status in
                          ('pending_upload','uploaded','transcribing','transcribed','error','purged')),
  consent_status        text not null default 'unknown' check (consent_status in
                          ('unknown','informed','explicit','declined')),
  language              text,
  error                 text,
  bridged_at            timestamptz,   -- doorgezet naar trainingsplatform
  bridge_error          text,
  audio_retention_until date not null default (current_date + 90),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index recordings_org_idx    on recordings (org_id);
create index recordings_member_idx on recordings (member_id);
create index recordings_status_idx on recordings (status);

-- 4 · Transcript + samenvatting (1-op-1 met recording)
create table transcripts (
  recording_id  uuid primary key references recordings(id) on delete cascade,
  provider      text not null default 'deepgram',
  language      text,
  full_text     text,
  segments      jsonb,
  word_count    integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table summaries (
  recording_id  uuid primary key references recordings(id) on delete cascade,
  summary       text,
  action_items  jsonb,          -- [{actie, eigenaar, deadline}]
  model         text,
  email_to      text,
  email_sent_at timestamptz,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 5 · Consent-log (GDPR-audit)
create table consents (
  id            uuid primary key default gen_random_uuid(),
  recording_id  uuid not null references recordings(id) on delete cascade,
  method        text not null check (method in ('app_notice','verbal','email','written','ivr_message','platform_banner','device_button')),
  confirmed_by  text,
  details       text,
  noted_at      timestamptz not null default now()
);

create index consents_recording_idx on consents (recording_id);

-- 6 · Instellingen per organisatie
create table org_settings (
  org_id                    uuid primary key references organizations(id) on delete cascade,
  consent_required          boolean not null default true,
  audio_retention_days      integer not null default 90 check (audio_retention_days between 7 and 730),
  email_summary_enabled     boolean not null default true,
  email_include_transcript  boolean not null default true,
  updated_at                timestamptz not null default now()
);

-- 7 · RLS-helpers
create or replace function is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from members m
                 where m.org_id = p_org and m.user_id = auth.uid() and m.is_active);
$$;

create or replace function is_org_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from members m
                 where m.org_id = p_org and m.user_id = auth.uid() and m.is_active
                   and m.role in ('owner','admin'));
$$;

create or replace function is_own_member(p_member uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from members m
                 where m.id = p_member and m.user_id = auth.uid());
$$;

-- 8 · RLS — service_role schrijft; leden lezen eigen scope.
--     Opnames zijn gevoelig: een lid ziet alleen ZIJN opnames; org-admins alles.
alter table organizations enable row level security;
alter table members       enable row level security;
alter table devices       enable row level security;
alter table recordings    enable row level security;
alter table transcripts   enable row level security;
alter table summaries     enable row level security;
alter table consents      enable row level security;
alter table org_settings  enable row level security;

create policy service_role_all on organizations for all using (auth.role() = 'service_role');
create policy orgs_select on organizations for select using (is_org_member(id));

create policy service_role_all on members for all using (auth.role() = 'service_role');
create policy members_select on members for select using (is_org_member(org_id));

create policy service_role_all on devices for all using (auth.role() = 'service_role');
create policy devices_select on devices for select
  using (is_org_admin(org_id) or is_own_member(member_id));

create policy service_role_all on recordings for all using (auth.role() = 'service_role');
create policy recordings_select on recordings for select
  using (is_org_admin(org_id) or is_own_member(member_id));

create policy service_role_all on transcripts for all using (auth.role() = 'service_role');
create policy transcripts_select on transcripts for select
  using (exists (select 1 from recordings r where r.id = recording_id
                 and (is_org_admin(r.org_id) or is_own_member(r.member_id))));

create policy service_role_all on summaries for all using (auth.role() = 'service_role');
create policy summaries_select on summaries for select
  using (exists (select 1 from recordings r where r.id = recording_id
                 and (is_org_admin(r.org_id) or is_own_member(r.member_id))));

create policy service_role_all on consents for all using (auth.role() = 'service_role');
create policy consents_select on consents for select
  using (exists (select 1 from recordings r where r.id = recording_id
                 and (is_org_admin(r.org_id) or is_own_member(r.member_id))));

create policy service_role_all on org_settings for all using (auth.role() = 'service_role');
create policy org_settings_select on org_settings for select using (is_org_member(org_id));

-- 9 · Privé-bucket; alle toegang via signed URLs (server-side aangemaakt)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 524288000,
        array['audio/mp4','audio/mpeg','audio/wav','audio/x-wav','audio/webm','audio/x-m4a','audio/aac','audio/ogg','video/mp4','video/webm'])
on conflict (id) do nothing;

-- 10 · updated_at-trigger
create or replace function touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

create trigger trg_touch before update on organizations for each row execute function touch_updated_at();
create trigger trg_touch before update on members       for each row execute function touch_updated_at();
create trigger trg_touch before update on devices       for each row execute function touch_updated_at();
create trigger trg_touch before update on recordings    for each row execute function touch_updated_at();
create trigger trg_touch before update on transcripts   for each row execute function touch_updated_at();
create trigger trg_touch before update on summaries     for each row execute function touch_updated_at();
create trigger trg_touch before update on org_settings  for each row execute function touch_updated_at();

-- 11 · Werkvoorraad-views (voor de edge functions, security_invoker)
create view v_pending_transcription with (security_invoker = on) as
select r.id, r.org_id, r.member_id, r.storage_path, r.started_at, r.language
from recordings r
left join org_settings s on s.org_id = r.org_id
where r.status = 'uploaded'
  and r.storage_path is not null
  and r.consent_status <> 'declined'
  and (coalesce(s.consent_required, true) = false
       or r.consent_status in ('informed','explicit'));

create view v_pending_summary with (security_invoker = on) as
select r.id, r.org_id, r.member_id, r.title, r.recording_type, r.started_at,
       r.duration_seconds, t.full_text, t.language,
       m.email as member_email, m.full_name as member_name,
       coalesce(s.email_include_transcript, true) as include_transcript
from recordings r
join transcripts t on t.recording_id = r.id and t.full_text is not null
join members m on m.id = r.member_id and m.receive_email_summary and m.is_active
left join org_settings s on s.org_id = r.org_id
where r.status = 'transcribed'
  and coalesce(s.email_summary_enabled, true)
  and not exists (select 1 from summaries su
                  where su.recording_id = r.id and su.email_sent_at is not null);

create view v_pending_bridge with (security_invoker = on) as
select r.id, r.started_at, r.duration_seconds,
       o.training_client_id, m.training_participant_id,
       t.full_text, t.segments, t.language, t.word_count
from recordings r
join organizations o on o.id = r.org_id and o.training_client_id is not null
join members m on m.id = r.member_id and m.training_participant_id is not null
join transcripts t on t.recording_id = r.id and t.full_text is not null
where r.status = 'transcribed' and r.bridged_at is null;

create view v_audio_to_purge with (security_invoker = on) as
select id, org_id, storage_path, audio_retention_until
from recordings
where status in ('uploaded','transcribed','error')
  and storage_path is not null
  and audio_retention_until < current_date;

-- 12 · Registratie-RPC (alleen service_role)
create or replace function register_transcript(
  p_recording_id uuid,
  p_full_text    text,
  p_segments     jsonb default null,
  p_language     text  default null,
  p_provider     text  default 'deepgram'
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_full_text is null or length(trim(p_full_text)) = 0 then
    raise exception 'register_transcript: leeg transcript voor %', p_recording_id;
  end if;
  insert into transcripts (recording_id, provider, language, full_text, segments, word_count)
  values (p_recording_id, p_provider, p_language, p_full_text, p_segments,
          array_length(regexp_split_to_array(trim(p_full_text), '\s+'), 1))
  on conflict (recording_id) do update set
    provider = excluded.provider, language = excluded.language,
    full_text = excluded.full_text, segments = excluded.segments,
    word_count = excluded.word_count, updated_at = now();
  update recordings
  set status = 'transcribed', language = coalesce(p_language, language), error = null
  where id = p_recording_id;
end $$;

revoke execute on function register_transcript(uuid, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function register_transcript(uuid, text, jsonb, text, text) to service_role;

commit;
