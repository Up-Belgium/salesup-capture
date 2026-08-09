# salesUp Capture — Google Play submissie (runbook)

App-config (`app.json`) is Android-klaar: package `be.salesup.capture`, `RECORD_AUDIO` + `FOREGROUND_SERVICE(_MICROPHONE)` + `MODIFY_AUDIO_SETTINGS`, versie 1.0.0. Play Console staat live.

## 1. Build + upload (in `apps/mobile/`)
```bash
eas build -p android --profile production      # levert een .aab
eas submit -p android --latest
```
`eas submit` heeft een **Google service-account-JSON** nodig (Play Console → Setup → API access → service account met "Release"-rechten). Alternatief: download de `.aab` en upload manueel in Play Console.

## 2. Play Console invullen
- **Store listing:** naam, korte + volledige omschrijving (uit `STORE_LISTING.md`), icoon, min. 2 telefoon-screenshots + feature graphic (1024×500).
- **Privacy policy-URL:** publiceer `PRIVACY_POLICY.md` (verplicht).
- **Data safety:** vul in volgens `APP_PRIVACY.md` (audio/opnames + e-mail = collected, encrypted in transit, deletion mogelijk, niet gedeeld met derden voor eigen doeleinden).
- **App access:** de app is **login-gated** → geef in "App access" een **testaccount** (zelfde reviewer-login als iOS) + korte instructie, anders kan Google niet testen.
- **Content rating:** vragenlijst invullen (business, geen gevoelige inhoud).
- **Target audience:** volwassenen/zakelijk (geen kinderen).
- **Ads:** "Nee, bevat geen advertenties".

## 3. Release-track
- Start met **Internal testing** (snel, geen volledige review) → test de download op een Android-toestel.
- Daarna **Production** → review (uren tot enkele dagen).

## 4. Na release
- OTA-updates via `eas update --branch production` (geen nieuwe review, behalve native/permissie-wijzigingen).

## Aandachtspunten
- **Foreground-service microfoon**: Google vraagt sinds kort een verantwoording voor `FOREGROUND_SERVICE_MICROPHONE` → leg in "App access"/review-notes uit dat opname enkel na expliciete gebruikersactie start (kwaliteit/coaching).
- Zorg dat de **privacy policy** de opnames + verwerkers dekt (Play kruischeckt policy ↔ Data safety).
