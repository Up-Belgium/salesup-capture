-- 003 — external_ref: id bij de externe capture-provider (bv. Recall sdk_upload)
-- (gerund op live 2026-06-12)
alter table recordings add column if not exists external_ref text;
