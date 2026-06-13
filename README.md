# salesUp Capture

Opnameplatform voor meetings (fysiek + videocall) en telefoongesprekken, in salesUp-stijl.
Eigen Supabase-project (`salesup-capture`, eu-west-1), los van de andere platformen,
met een brug naar het trainingsplatform voor de kwaliteitsanalyse.

## Wat het doet

1. **Opnemen** via meerdere kanalen:
   - **Videocalls (aanbevolen): agenda-koppeling** — gebruiker verbindt zijn Google
     Agenda met één klik (OAuth, `calendar-oauth` → Recall Calendar V2). Daarna
     verschijnt de zichtbare bot "salesUp Capture" automatisch in elke geplande
     meeting (`sync-calendars`, cron */5). Geen installatie, geen geheime URL,
     intrekbaar; klant-IT-admin kan de app domain-wide goedkeuren.
   - **Videocall ad-hoc**: meeting-link plakken → bot sturen (`bot_start`).
   - Desktop-app (botloze SDK-opname), mobiele app (fysiek/telefoon-op-speaker),
     hardware-device (Plaud-model), integratie-webhook.
2. **Transcriberen** binnen ±10 minuten (Deepgram, NL + sprekerherkenning).
3. **Per mail na elke meeting**: samenvatting + actielijst (Claude) + volledig
   transcript, naar de eigenaar van de opname (Resend).
4. **Brug naar het trainingsplatform**: getranscribeerde gesprekken van gekoppelde
   organisaties stromen automatisch de bestaande AI-scorecard/competentie-analyse in.

## Structuur

```
supabase/
  migrations/001_init.sql      schema: organizations, members, devices, recordings,
                               transcripts, summaries, consents, org_settings (alles RLS)
  functions/ingest-recording   ingest (JWT / device-token / integratie-secret)
  functions/transcribe-recordings   Deepgram, cron */10
  functions/summarize-email    Claude + Resend, cron 5-55/10
  functions/bridge-to-training doorzet naar trainingsproject, cron :25
  cron/setup_vault_secret.sql  niet meer nodig (crons draaien via anon-JWT); referentie
  seed_first_org.sql           eenmalig: eerste organisatie + owner (salesUp = gedaan)
apps/
  mobile/                      Expo-app (iOS + Android)
  desktop/                     Electron tray-app (meetingdetectie, geen bot)
hardware/
  firmware/capture_recorder/   ESP32-S3 prototype (Plaud-model)
```

## Status & secrets

Schema, functions en crons staan **live** op project `plbuczbxtauhuobkicdr`.
Vereiste Edge Function secrets (Dashboard → Edge Functions → Secrets):

| Secret | Voor | Verplicht |
|---|---|---|
| `DEEPGRAM_API_KEY` | transcriptie | ja |
| `ANTHROPIC_API_KEY` | samenvatting | ja |
| `RESEND_API_KEY` | mail | ja |
| `CAPTURE_EMAIL_FROM` | afzender (default `capture@salesup.be` — domein in Resend verifiëren) | nee |
| `TRAINING_URL` + `TRAINING_SERVICE_ROLE_KEY` | brug naar trainingsplatform | alleen voor de brug |
| `CAPTURE_INGEST_SECRET` | Recall/integratie-webhooks | alleen voor integraties |

De crons draaien automatisch (anon-JWT als Bearer — geen vault-stap nodig). Nieuwe
organisaties/leden maak je aan naar het voorbeeld van `supabase/seed_first_org.sql`.


## Beveiliging

- RLS op alle tabellen; een lid ziet alleen eigen opnames, org-admins de hele organisatie.
- Privé-storage-bucket; uploads/downloads uitsluitend via kortlevende signed URLs.
- Apps bevatten geen geheimen (anon key is publiek by design; autorisatie server-side).
- Hardware-devices: per-device token, alleen de sha256-hash in de database, per stuk intrekbaar.
- Consent verplicht vóór verwerking + audit-log; audio-retentie 90 dagen (instelbaar), transcripten langer.

## Bekende platform-grenzen

Automatisch gewone telefoongesprekken aftappen kan niet (iOS geeft geen toegang,
Google blokkeert sinds 2022) — daarom het hardware-device en telefoon-op-speaker in de
mobiele app, exact zoals Plaud het oplost.
