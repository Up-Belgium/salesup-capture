# salesUp Capture desktop — signeren & notariseren (macOS)

De build-config is al voorbereid: **hardened runtime**, **entitlements** (microfoon/camera) en
het **app-icoon** staan ingesteld. Een gewone `npm run dist` werkt ook **zonder** certificaat
(de app is dan enkel niet gesigneerd → gebruiker moet "rechterklik → Open" doen).

## 1. Signeren (verwijdert "app van onbekende ontwikkelaar")
1. Maak/haal je **"Developer ID Application"**-certificaat op developer.apple.com
   (Certificates → +) en **installeer het in je Keychain** (dubbelklik het `.cer`,
   of via Xcode → Settings → Accounts → Manage Certificates).
2. Daarna pikt `npm run dist` het automatisch op (electron-builder auto-discovery) en
   signeert met hardened runtime. Geen verdere config nodig.

Controle achteraf:
```bash
codesign -dv --verbose=4 "dist/mac-arm64/salesUp Capture.app"
```

## 2. Notariseren (verwijdert óók het Gatekeeper-stapje volledig)
1. Maak een **app-specifiek wachtwoord** op appleid.apple.com (Inloggen & beveiliging →
   App-specifieke wachtwoorden).
2. Zet de env-variabelen (eenmalig per terminal):
   ```bash
   export APPLE_ID="jouw@apple-id.be"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="JOUW_TEAM_ID"   # zie developer.apple.com → Membership
   ```
3. Bouw mét notarisatie ingeschakeld:
   ```bash
   npm run dist -- --config.mac.notarize.teamId="$APPLE_TEAM_ID"
   ```
   electron-builder uploadt dan automatisch naar Apple (notarytool) en "staplet" het ticket.
   (Eerste keer duurt notarisatie enkele minuten.)

> We laten `notarize` bewust **uit** de vaste config zodat een build zonder credentials
> nooit faalt. Wil je het permanent aan? Voeg dan
> `"notarize": { "teamId": "JOUW_TEAM_ID" }` toe aan het `mac`-blok in package.json.

## 3. Uploaden
De gesigneerde/genotariseerde DMG's (`salesUp-Capture-<versie>-arm64.dmg` en `-x64.dmg`)
upload je naar de GitHub-release `v<versie>` in `salesup-capture-downloads`.
