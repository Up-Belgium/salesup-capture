# salesUp Capture — setup-checklist (acties voor salesUp)

Alles in de code/backend is gebouwd en live op Supabase-project `salesup-capture`
(ref `plbuczbxtauhuobkicdr`). Dit zijn de resterende handelingen die alleen jullie
kunnen doen — per onderdeel, in volgorde van impact.

## ✅ Al werkend (niets te doen)
- Videocall-opname via agenda (Google) — end-to-end getest: bot → transcript →
  samenvatting + actiepunten → mail. Werkt ook voor Zoom/Teams/Webex (zelfde bot-API).
- Mail per meeting (Deepgram + Claude + Resend) — secrets staan.
- Bot toont een salesUp-branded cover in de meeting.
- Multi-tenant + RLS + consent-log + retentie.

## 1 · Invite-only uitrol (bulk)  — function `invite-members`
- Zet secret **`CAPTURE_ADMIN_SECRET`** (zelfgekozen lange random string) voor
  centrale bulk-invites vanuit salesUp.
- Aanroep (per klant): `POST /functions/v1/invite-members` met header
  `X-Admin-Secret` en body `{ "org_id": "...", "role": "member", "emails": [...] }`.
  Owners/admins van een org kunnen het ook met hun eigen login.
- Een aparte organisatie per klant: één rij in `organizations` (+ `org_settings`).
  Zie `supabase/seed_first_org.sql` als voorbeeld.

## 2 · Microsoft-agenda's  — function `calendar-oauth` (al provider-aware)
- Registreer een **Azure AD-app** (portal.azure.com → App registrations):
  - Redirect URI (Web): `https://plbuczbxtauhuobkicdr.functions.supabase.co/calendar-oauth`
  - API-permissies (Microsoft Graph, delegated): `Calendars.Read`, `offline_access`, `openid`, `email`
  - Maak een client secret aan.
- Zet secrets **`MS_OAUTH_CLIENT_ID`** + **`MS_OAUTH_CLIENT_SECRET`**.
- In de app kiest een Microsoft-klant dan "Microsoft" bij Verbind agenda.

## 3 · Koppeling met het trainingsplatform  — function `bridge-to-training`
- Zet secrets **`TRAINING_URL`** (`https://mwnoslnvkausubvgubug.supabase.co`) en
  **`TRAINING_SERVICE_ROLE_KEY`** (service-key van het trainingsproject).
- Leg de mapping: `organizations.training_client_id` = `clients.id` in training, en
  per lid `members.training_participant_id` = `training_participants.id`. Pas dan
  stromen die opnames in de bestaande kwaliteits-/competentie-analyse.
- Zonder deze config slaat de brug netjes over (geen fout).

## 4 · Hardware (Plaud-model)
- Prototype: print `hardware/case/salesup_capture_case.scad` (MagSafe-ring of plakker),
  bestel het XIAO ESP32S3 Sense-board (~€20), flash de firmware.
- Productie: kies white-label ODM-hardware met magneetclip i.p.v. zelf certificeren.

## 5 · App-distributie naar de stores (mobiel)
- Apple Developer Program (€99/j) + Google Play Console ($25) → dan bouw ik de
  store-builds (EAS) en is de installatie één-klik. De app-code is klaar.
- Desktop-app: nu een ongesigneerde build; voor nette distributie zonder
  permissie-gedoe is dezelfde Apple Developer-identiteit nodig (signing + notarisatie).

## Branding
- Lever een echt logobestand (PNG/SVG) aan → vervangt de tekst-wordmark in de apps
  en de bot-cover.
