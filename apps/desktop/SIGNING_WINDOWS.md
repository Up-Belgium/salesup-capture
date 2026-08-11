# salesUp Capture desktop — Windows signeren (EV, vanaf Mac)

Doel: de **SmartScreen "onbekende uitgever"-waarschuwing** wegwerken met een **EV code-signing-certificaat** via **SSL.com eSigner** (cloud-HSM). Werkt volledig vanaf een Mac — geen Windows nodig, en **geen herbouw** van de app.

## Eenmalig — certificaat (jouw taak; duurt enkele dagen–weken)
1. Koop bij **SSL.com** een **EV Code Signing**-certificaat (met **eSigner** cloud-signing).
2. Doorloop de **EV-validatie**: bedrijfsdocumenten + telefonische verificatie. (EV = strenge validatie; reken op enkele dagen tot weken.)
3. Activeer **eSigner** in je SSL.com-dashboard en noteer:
   - je **account-e-mail** en **wachtwoord**
   - de **TOTP-secret** (eSigner → 2FA/OTP-instellingen → voor automatisch signeren)

## Eenmalig — tooling op je Mac (klein)
```bash
brew install --cask temurin        # Java (JRE), nodig voor CodeSignTool
```
Download **CodeSignTool** (Linux/macOS-versie) bij SSL.com, pak het uit in `apps/desktop/CodeSignTool/` en maak het uitvoerbaar:
```bash
chmod +x apps/desktop/CodeSignTool/CodeSignTool.sh
```
Haal je **credential_id** op:
```bash
cd apps/desktop/CodeSignTool
./CodeSignTool.sh get_credential_ids -username="je@mail" -password="je-wachtwoord"
```

## Elke keer — de .exe signeren + heruploaden (5 min, geen herbouw)
De bestaande installer signeer je in-place:
```bash
cd apps/desktop
export ESIGNER_USERNAME="je@mail"
export ESIGNER_PASSWORD="je-wachtwoord"
export ESIGNER_CREDENTIAL_ID="xxxx-xxxx-..."
export ESIGNER_TOTP_SECRET="....=="
./sign-win.sh dist/salesUp-Capture-Setup-0.1.0.exe
```
Daarna in de GitHub-release de **oude** `salesUp-Capture-Setup-0.1.0.exe` vervangen door de **gesigneerde**.

## Belangrijk
- **Secrets** (wachtwoord, TOTP-secret) staan **enkel in env-vars**, nooit in git.
- **EV** geeft **onmiddellijk** SmartScreen-vertrouwen — geen "Toch uitvoeren" meer nodig vanaf de eerste download.
- Alternatief provider met dezelfde aanpak: **DigiCert KeyLocker** (`smctl`), maar iets Windows-georiënteerder.
