-- 008: de brug naar training geeft ook het opnametype door (okt 2026, Fase 0 split
-- Call Quality / Sales Quality). Training bewaart het als medium (video/fysiek) naast
-- module 'sales'; de titel ging al mee in de view maar werd niet doorgezet.
create or replace view v_pending_bridge with (security_invoker = on) as
 select r.id,
    r.started_at,
    r.duration_seconds,
    o.training_client_id,
    m.training_participant_id,
    t.full_text,
    t.segments,
    t.language,
    t.word_count,
    r.title,
    r.recording_type
   from recordings r
     join organizations o on o.id = r.org_id and o.training_client_id is not null
     join members m on m.id = r.member_id and m.training_participant_id is not null
     join transcripts t on t.recording_id = r.id and t.full_text is not null
  where r.status = 'transcribed' and r.bridged_at is null and r.share_to_training is true;
