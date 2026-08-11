#!/usr/bin/env bash
# Signeert de Windows-installer met een Certum EV-certificaat in de cloud
# (SimplySign) via jsign + PKCS#11. Werkt op macOS — geen Windows, geen herbouw:
# het signeert de bestaande .exe in-place.
#
# Java + jsign staan LOKAAL klaar in ./tools (geen brew/installatie nodig):
#   tools/jdk-*/Contents/Home/bin/java   (draagbare Temurin JDK)
#   tools/jsign.jar
#
# Nog nodig (eenmalig): SimplySign Desktop (van Certum) geinstalleerd + ingelogd,
# en de SimplySign mobiele app voor de OTP.
#
# Credentials/pad via env (NOOIT secrets in git):
#   CERTUM_PKCS11_LIB   pad naar de SimplySign PKCS#11-library (.dylib) — zie doc
#   CERTUM_ALIAS        certificaat-alias in de token
#   CERTUM_PIN          je SimplySign PIN/wachtwoord
#
# Gebruik:
#   export CERTUM_PKCS11_LIB=... CERTUM_ALIAS=... CERTUM_PIN=...
#   ./sign-win.sh dist/salesUp-Capture-Setup-0.1.0.exe
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$HERE/tools"
JAVA="$(find "$TOOLS" -maxdepth 4 -type f -path '*/Contents/Home/bin/java' | head -1)"
JSIGN="$TOOLS/jsign.jar"
EXE="${1:-$HERE/dist/salesUp-Capture-Setup-0.1.0.exe}"

[ -x "$JAVA" ] || { echo "Lokale Java niet gevonden onder $TOOLS"; exit 1; }
[ -f "$JSIGN" ] || { echo "jsign.jar niet gevonden in $TOOLS"; exit 1; }
[ -f "$EXE" ]   || { echo "Bestand niet gevonden: $EXE"; exit 1; }
: "${CERTUM_PKCS11_LIB:?zet CERTUM_PKCS11_LIB (pad naar de SimplySign PKCS#11 .dylib)}"
: "${CERTUM_ALIAS:?zet CERTUM_ALIAS}"
: "${CERTUM_PIN:?zet CERTUM_PIN}"

# PKCS#11-config voor jsign (tijdelijk bestand, geen secrets erin).
CFG="$(mktemp)"; trap 'rm -f "$CFG"' EXIT
printf 'name = Certum\nlibrary = %s\nslot = 0\n' "$CERTUM_PKCS11_LIB" > "$CFG"

echo "Signeren: $EXE"
"$JAVA" -jar "$JSIGN" \
  --storetype PKCS11 \
  --keystore "$CFG" \
  --storepass "$CERTUM_PIN" \
  --alias "$CERTUM_ALIAS" \
  --tsaurl http://time.certum.pl \
  "$EXE"

echo "Klaar. Getekend bestand: $EXE"
echo "Aliassen tonen kan met:  \"$JAVA\" -jar \"$JSIGN\" --storetype PKCS11 --keystore <cfg> --storepass '<PIN>'"
