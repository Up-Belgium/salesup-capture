# salesUp Capture desktop — Windows signeren (Certum EV cloud, vanaf Mac)

Doel: de **SmartScreen "onbekende uitgever"-waarschuwing** wegwerken met een
**EV code-signing-certificaat** van **Certum** (Code Signing in de Cloud / SimplySign).
EV = **meteen** vertrouwd, geen "Toch uitvoeren" meer. Werkt vanaf Mac, **geen herbouw**.

## Stap 1 — certificaat kopen + valideren (jouw taak; de trage stap)
1. Koop bij **Certum** een **EV Code Signing — in de cloud (SimplySign)**.
2. Doorloop de **EV-validatie**: bedrijfsdocumenten + verificatie. ⏳ Reken op enkele dagen tot weken.
3. Activeer **SimplySign**: je krijgt toegang tot je certificaat in Certum's cloud-HSM.

## Stap 2 — tooling op je Mac (eenmalig, klein)
```bash
brew install --cask temurin      # Java
brew install jsign               # cross-platform Authenticode-signer
```
Installeer **SimplySign Desktop** (van Certum) + de **SimplySign mobiele app** (voor de OTP).
Log in in SimplySign Desktop → dat activeert je cloud-certificaat als een lokale PKCS#11-token.

**Zoek het PKCS#11-modulepad** (nodig voor het script). Meestal iets als:
`/Applications/SimplySignDesktop.app/Contents/.../*.dylib` of onder `~/Library`. 
→ Zeg me wat je vindt, dan zet ik het exacte pad in.

## Stap 3 — de .exe signeren (± 5 min, geen herbouw)
```bash
cd apps/desktop
export CERTUM_PKCS11_LIB="/pad/naar/simplysign/pkcs11.dylib"
export CERTUM_ALIAS="<alias>"          # tonen: jsign --storetype PKCS11 --keystore <cfg> --storepass <PIN>
export CERTUM_PIN="<je-SimplySign-PIN>"
./sign-win.sh dist/salesUp-Capture-Setup-0.1.0.exe
```
Tijdens het signeren bevestig je de OTP via de **SimplySign mobiele app**.
Daarna in de GitHub-release de **oude** `.exe` vervangen door de **gesigneerde**.

## Belangrijk
- **Secrets** (PIN) staan enkel in env-vars, nooit in git.
- Het script timestampt met Certum's TSA (`time.certum.pl`) → handtekening blijft geldig ná verloop van het cert.
- Zodra je SimplySign geïnstalleerd hebt, doen we stap 3 **samen live** — dan finaliseren we het exacte modulepad + alias en testen we één signing.
