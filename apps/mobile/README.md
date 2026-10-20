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
3. Opnemen. De app houdt het scherm wakker om de timer zichtbaar te houden.
   Bij handmatig vergrendelen blijft de opname actief via
   `allowsBackgroundRecording: true` en de Expo-pluginoptie
   `enableBackgroundRecording: true` (iOS `UIBackgroundModes: audio`;
   Android microfoon-foreground-service). Op iOS is alleen de bestaande
   microfoontoestemming nodig, geen aparte toestemming voor achtergrondopname.
4. Stop & verstuur — upload via signed URL naar de privé-bucket; mislukte uploads
   blijven op het toestel en zijn opnieuw te versturen.

Daarna is alles automatisch: de nachtelijke `transcribe-recordings` (02:45) en
`evaluate-calls` (03:00) maken er een geanalyseerd gesprek van, zichtbaar in het
dashboard onder **Opnames** en **Call Quality**.

## Snelstart — één gebaar → meteen opnemen

De app heeft een groot één-tik opnameveld op het hoofdscherm. Voor een écht "geheime
knop"-gevoel zónder de app te openen, koppel je de diepe link in iOS:

1. Zet in de app **Snelstart** + **"Ik informeer mijn gesprekspartners"** aan.
2. iOS → **Opdrachten**-app → nieuwe opdracht **"Open URL"** → `salesupcapture://record`.
3. Koppel die opdracht aan één van:
   - **Tik op achterkant** (Instellingen → Toegankelijkheid → Aanraken → Tik op
     achterkant → Dubbele/Driedubbele tik → jouw opdracht) — dubbeltik op de
     achterkant van de telefoon en de opname start.
   - **Action Button** (iPhone 15 Pro+) → Opdracht.
   - **Siri**: "Hey Siri, start opname".
   - **Bedieningspaneel / Vergrendelscherm** (iOS 18-bediening).

De zijknop/slaaptoets zelf kan geen enkele iOS-app overnemen — dit is de native,
App-Store-conforme manier om hetzelfde resultaat te krijgen.

## Lokaal draaien

```bash
cd apps/mobile
npm ci
npx expo start         # QR-code scannen met Expo Go (let op: background-audio
                       # werkt pas volledig in een development/production build)
```

Op een Mac met Xcode kun je een eigen app-build in de iPhone-simulator starten:

```bash
cd apps/mobile
npm ci
npx expo run:ios --device "iPhone 17 Pro"
```

De eerste keer genereert Expo het native iOS-project en installeert CocoaPods-
dependencies. Hiervoor is geen betaalde Apple Developer-account nodig.
De simulator is geschikt om de schermen, microfoontoestemming en basisopname
te controleren; echte sluimerstand en onderbrekingen door oproepen moeten op
een fysieke iPhone getest worden. Gebruik voor achtergrondopname een eigen
native build met de pluginconfiguratie, niet Expo Go.

Controle op een echte iPhone: start een opname, spreek vóór het vergrendelen,
houd het toestel enkele minuten vergrendeld en spreek ook in die periode.
Ontgrendel, stop en controleer of alle gesproken delen aanwezig zijn. Controleer
ook wisselen naar een andere app en hervatten na een oproep.
De automatische segmentrotatie na twintig minuten werkt momenteel alleen op de
voorgrond; lange achtergrondopnames kunnen daardoor nog de uploadlimiet raken.

## Builds voor de stores (EAS) — Apple Developer-account is opgezet ✓

`eas.json` met drie profielen staat klaar (development/preview/production) en
`expo-doctor` is groen (18/18). Eenmalig (op jouw Mac, met jouw Apple/Expo-login):

```bash
cd apps/mobile
npm install
npm install -g eas-cli
eas login                       # je Expo-account
eas build:configure             # koppelt het project (schrijft projectId)
```

**Op je eigen iPhone testen (snelst):**
```bash
eas device:create               # registreer je toestel (scan QR / volg de link)
eas build --platform ios --profile preview
```
→ EAS bouwt in de cloud (Apple-credentials worden interactief beheerd) en geeft een
installeerbare link/QR voor je toestel. Hierin werkt de achtergrond-audio én de
snelstart-deeplink (anders dan in Expo Go).

**Naar TestFlight / App Store:**
```bash
eas build --platform ios --profile production
eas submit --platform ios
```

Android (later, na Google Play Console $25):
```bash
eas build --platform android --profile preview     # APK om te zijladen
eas build --platform android --profile production   # AAB voor Play Console
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
