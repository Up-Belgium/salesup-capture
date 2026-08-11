#!/usr/bin/env bash
# Signeert de Windows-installer met SSL.com eSigner CodeSignTool (EV, cloud-HSM).
# Werkt op macOS — geen Windows nodig. Signeert de bestaande .exe IN-PLACE,
# dus geen herbouw. Daarna gewoon opnieuw uploaden naar de GitHub-release.
#
# Vereisten:
#   - Java (JRE) geinstalleerd:  brew install --cask temurin   (of een andere JDK)
#   - CodeSignTool uitgepakt (download bij SSL.com) in ./CodeSignTool
#     of geef de map mee via env CODESIGNTOOL_DIR.
#
# Credentials via env (NOOIT in dit bestand of in git):
#   ESIGNER_USERNAME       je SSL.com-account e-mail
#   ESIGNER_PASSWORD       je SSL.com-wachtwoord
#   ESIGNER_CREDENTIAL_ID  via:  ./CodeSignTool.sh get_credential_ids -username=... -password=...
#   ESIGNER_TOTP_SECRET    de TOTP-secret uit je eSigner-instellingen (voor automatisch signeren)
#
# Gebruik:
#   export ESIGNER_USERNAME=... ESIGNER_PASSWORD=... ESIGNER_CREDENTIAL_ID=... ESIGNER_TOTP_SECRET=...
#   ./sign-win.sh dist/salesUp-Capture-Setup-0.1.0.exe
set -euo pipefail

EXE="${1:-dist/salesUp-Capture-Setup-0.1.0.exe}"
TOOL_DIR="${CODESIGNTOOL_DIR:-./CodeSignTool}"

[ -f "$EXE" ] || { echo "Bestand niet gevonden: $EXE"; exit 1; }
[ -x "$TOOL_DIR/CodeSignTool.sh" ] || { echo "CodeSignTool niet gevonden in $TOOL_DIR (download bij SSL.com en pak uit)"; exit 1; }
: "${ESIGNER_USERNAME:?zet ESIGNER_USERNAME}"
: "${ESIGNER_PASSWORD:?zet ESIGNER_PASSWORD}"
: "${ESIGNER_CREDENTIAL_ID:?zet ESIGNER_CREDENTIAL_ID}"
: "${ESIGNER_TOTP_SECRET:?zet ESIGNER_TOTP_SECRET}"

echo "Signeren: $EXE"
"$TOOL_DIR/CodeSignTool.sh" sign \
  -username="$ESIGNER_USERNAME" \
  -password="$ESIGNER_PASSWORD" \
  -credential_id="$ESIGNER_CREDENTIAL_ID" \
  -totp_secret="$ESIGNER_TOTP_SECRET" \
  -input_file_path="$EXE" \
  -override="true"

echo "Klaar. Getekend bestand: $EXE"
echo "Controle (optioneel, op een Windows-pc): rechterklik .exe -> Eigenschappen -> Digitale handtekeningen."
