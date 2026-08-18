-- 004 · Async-transcriptie tracking
-- poll-bots stapt over van Recall streaming-ASR (recallai_streaming) naar async
-- batch-transcriptie (recallai_async): één taalbeslissing per opname + aparte
-- deelnemersstreams voor de diarisatie. Dit kolommetje bewaart het async job-id
-- tussen twee cron-runs (aanvragen → pollen tot 'done' → registreren).
alter table recordings add column if not exists recall_async_transcript_id text;

comment on column recordings.recall_async_transcript_id is
  'Recall async-transcript job-id (recallai_async). poll-bots vraagt async transcriptie aan na de opname en pollt op dit id tot status done; vervangt de zwakke streaming-transcriptie.';
