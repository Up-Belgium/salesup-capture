# salesUp Capture — iOS App Store submissie (runbook)

App-config staat klaar (`app.json`): bundle `be.salesup.capture`, versie **1.0.0**, mic-permissie, `UIBackgroundModes: audio`, `ITSAppUsesNonExemptEncryption: false`, deeplink `salesupcapture://`, OTA via EAS. Je hoeft dus enkel de stappen hieronder te doen.

## 0. Vooraf (eenmalig)
- Apple Developer Program actief ($99/j) ✅
- App-record in **App Store Connect** (naam "salesUp Capture", bundle `be.salesup.capture`). Zo niet: `eas submit` maakt 'm aan, of maak 'm manueel.
- **Reviewer-testaccount** in het Capture-project aanmaken (zie `APP_REVIEW_NOTES.md`) — verplicht, want de app is login-gated.
- **Privacy policy publiceren** op een publieke URL (tekst = `PRIVACY_POLICY.md`). Nodig vóór submit.

## 1. Build + upload (jouw commando's, in `apps/mobile/`)
```bash
eas build -p ios --profile production
eas submit -p ios --latest
```
`eas submit` vraagt je Apple-login (App-specific password of ASC API-key) en uploadt de build naar App Store Connect.

## 2. In App Store Connect invullen
- **App Information:** categorie (Business), rechten, privacy policy-URL, support-URL.
- **Version 1.0:** screenshots (min. 6.7" iPhone), beschrijving, keywords, wat-is-nieuw.
- **App Privacy:** zie `APP_PRIVACY.md` (audio/opnames + account = collected, linked).
- **App Review Information:** plak de tekst uit `APP_REVIEW_NOTES.md` + vul reviewer-login in + zet "Sign-in required" aan.
- **Export compliance:** al afgehandeld via `ITSAppUsesNonExemptEncryption: false` → geen vragen.
- **Build** selecteren → **Add for Review** → **Submit**.

## 3. Na goedkeuring
- **Release** (manueel of automatisch).
- OTA voor volgende updates: `eas update --branch production` → geen nieuwe review nodig (enkel bij native/permissie-wijzigingen wél).

## Aandachtspunten (afkeur-risico's)
- **Background-audio + microfoon** worden streng bekeken → de review-notes leggen het gebruik + consent uit; zorg dat het consent-scherm zichtbaar is bij eerste opname.
- **Login-gated** → zonder werkend reviewer-account = zekere afkeuring.
- **Privacy policy-URL** moet live zijn en de opnames dekken.
