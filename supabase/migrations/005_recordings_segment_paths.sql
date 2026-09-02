-- Fase 2 opname-segmenten: één opname kan uit meerdere audiosegmenten bestaan
-- (na een onderbreking, bv. een oproep). Segment 1 = recordings.storage_path;
-- extra segmenten komen in segment_paths. transcribe-recordings plakt
-- storage_path + segment_paths in volgorde aan elkaar tot één transcript/verslag.
alter table public.recordings
  add column if not exists segment_paths text[] not null default '{}';

comment on column public.recordings.segment_paths is
  'Extra audiosegment-paden na onderbrekingen. Segment 1 = storage_path; transcribe-recordings concateneert storage_path + segment_paths tot één transcript.';
