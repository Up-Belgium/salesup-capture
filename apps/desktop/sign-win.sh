#!/usr/bin/env bash
# Signeert de Windows-installer met een Certum EV-certificaat in de cloud
# (SimplySign) via jsign + PKCS#11. Werkt op macOS — geen Windows nodig, en
# GEEN herbouw: het signeert de bestaande .exe in-place.
#
# Vereisten (eenmalig):
#   - Java:            brew install --cask temurin
#   - jsign:           brew install jsign
#   - SimplySign Desktop (van Certum) geinstalleerd + ingelogd (levert de PKCS#11-
#     module + een virtuele kaartlezer). SimplySign mobiele app voor de OTP/2FA.
#
# Vul het PKCS#11-modulepad + alias in via env (NOOIT secrets in git):
#   CERTUM_PKCS11_LIB   pad naar de SimplySign PKCS#11-library (.dylib) — zie doc
#   CERTUM_ALIAS        certificaat-alias in de token (jsign --storetype PKCS11 toont de aliassen)
#   CERTUM_PIN          je SimplySign PIN/wachtwoord
#
# Gebruik:
#   export CERTUM_PKCS11_LIB=... CERTUM_ALIAS=... CERTUM_PIN=...
#   ./sign-win.sh dist/salesUp-Capture-Setup-0.1.0.exe
set -euo pipefail

EXE="${1:-dist/salesUp-Capture-Setup-0.1.0.exe}"
[ -f "$EXE" ] || { echo "Bestand niet gevonden: $EXE"; exit 1; }
: "${CERTUM_PKCS11_LIB:?zet CERTUM_PKCS11_LIB (pad naar de SimplySign PKCS#11 .dylib)}"
: "${CERTUM_ALIAS:?zet CERTUM_ALIAS}"
: "${CERTUM_PIN:?zet CERTUM_PIN}"

# PKCS#11-config voor jsign (tijdelijk bestand, geen secrets erin).
CFG="$(mktemp)"
trap 'rm -f "$CFG"' EXIT
printf 'name = Certum\nlibrary = %s\nslot = 0\n' "$CERTUM_PKCS11_LIB" > "$CFG"

echo "Signeren: $EXE"
jsign \
  --storetype PKCS11 \
  --keystore "$CFG" \
  --storepass "$CERTUM_PIN" \
  --alias "$CERTUM_ALIAS" \
  --tsaurl http://time.certum.pl \
  "$EXE"

echo "Klaar. Getekend bestand: $EXE"
echo "Tip: aliassen tonen kan met  jsign --storetype PKCS11 --keystore \"$CFG\" --storepass '<PIN>'"
