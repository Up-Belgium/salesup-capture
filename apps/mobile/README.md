# salesUp Capture — mobiele app (iOS + Android)

Opnemen van **fysieke meetings** en **telefoongesprekken op speaker**, met automatische
upload naar de capture-pipeline van het trainingsplatform (transcriptie via Deepgram →
AI-scorecards → competentie-analyse, allemaal bestaand).

## Wat de app doet (MVP, fase 3)

1. Inloggen met het bestaande trainingsplatform-account (Supabase Auth) — er zitten
   **geen geheimen** in de app; de `ingest-recording` edge function valideert de JWT en
   dwingt de klant-scope server-side af (trainee → eigen deelnemer, manager → eigen
   klant, trainer → toegewezen klanten, agency → alles).
2. Type kiezen (fysieke meeting / telefoon-op-speaker / videocall), consent-schakelaar
   **verplicht** vóór de start (GDPR — wordt als `app_notice` gelogd in `capture_consents`).
3. Opnemen — loopt door op de achtergrond en met het scherm uit
   (iOS `UIBackgroundModes: audio`, Android foreground service).
4. Stop & verstuur — upload via signed URL naar de privé-bucket; mislukte uploads
   blijven op het toestel en zijn opnieuw te versturen.

Daarna is alles automatisch: de nachtelijke `transcribe-recordings` (02:45) en
`evaluate-calls` (03:00) maken er een geanalyseerd gesprek van, zichtbaar in het
dashboard onder **Opnames** en **Call Quality**.

## Lokaal draaien

```bash
cd capture-mobile
npm install            # of: pnpm install
npx expo install --fix # versies uitlijnen op de Expo SDK
npx expo start         # QR-code scannen met Expo Go (let op: background-audio
                       # werkt pas volledig in een development/production build)
```

## Builds voor de stores (EAS)

Vereist: Apple Developer-account (€99/j) en Google Play Console (eenmalig $25).

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --platform ios       # TestFlight
eas build --platform android   # AAB voor Play Console (of --profile preview voor APK)
```

## Bewuste beperkingen (zie Structuurvoorstel_Capture_Platform_v1.md §2.3)

- **Gewone telefoongesprekken automatisch opnemen kan niet**: iOS geeft apps geen
  toegang tot de belaudio en Google blokkeert het op Android sinds 2022. De app
  ondersteunt daarom telefoon-op-speaker; volautomatische telefoonopname komt via het
  zakelijke VoIP-belnummer (fase 4).
- **Auto-start bij agenda-events** (push "meeting gestart — tik om op te nemen") is de
  geplande volgende stap (fase 3b): expo-calendar + expo-notifications; opnemen zelf
  blijft altijd een bewuste tik — dat is op iOS verplicht en het is GDPR-technisch ook
  de juiste keuze.

## Roadmap-haakjes die er al zijn

- `capture_sources`: registreer dit toestel per gebruiker zodat het individueel
  intrekbaar is (`is_active=false`) — kolommen bestaan al, app stuurt nog geen source_id.
- `action 'context'` levert nu al de klantenlijst per rol; deelnemer-koppeling voor
  niet-trainee-gebruikers gebeurt in het dashboard (Opnames → "Koppel aan deelnemer").
