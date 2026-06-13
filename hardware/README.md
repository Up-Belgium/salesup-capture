# salesUp Capture — hardware-prototype (Plaud-model)

Een fysiek opname-apparaatje dat — net als Plaud — gewoon via de microfoon naast de
telefoon of op de vergadertafel ligt. Daarmee omzeil je de iOS/Android-blokkades op
gespreksopname volledig: het device hoort wat jij hoort.

## Eerlijke verwachtingen

| Stap | Doorlooptijd | Kost |
|---|---|---|
| **Werkend prototype** (dit ontwerp, off-the-shelf board) | dagen | ±€20/stuk |
| Mooi behuisd prototype (3D-print, batterijoptimalisatie) | weken | ±€40/stuk |
| Verkoopbaar product (CE/FCC-certificering, productie, MagSafe-vorm) | 6–12 maanden | serieus budget |

Voor klantenpilots is stap 1–2 genoeg. Voor "een Plaud verkopen onder eigen merk":
overweeg white-label hardware (er bestaan ODM-fabrikanten van AI-voicerecorders) in
plaats van zelf certificeren — het platform hier werkt met elk device dat WAV-bestanden
naar onze ingest kan sturen.

## Behuizing + bevestiging op de telefoon (magneet of plakker)

Twee sporen, afhankelijk van fase:

- **Prototype (nu):** print de behuizing uit `case/salesup_capture_case.scad`. Die
  heeft (a) een microfoon-gaatje, (b) een opening voor USB-C/knop, en (c) een ronde
  uitsparing aan de achterkant voor een **MagSafe-magneetring (Ø56 mm)**. Lijm zo'n
  goedkope zelfklevende magneetring in de uitsparing → het kastje klikt op de
  achterkant van een iPhone (of op een magneet-sticker op een Android). Geen
  magneetring nodig? Het achtervlak is plat genoeg voor een **3M-plakstrip**.
  Meet je samengestelde board+batterij op en pas de variabelen bovenaan het
  `.scad`-bestand aan vóór het printen.
- **Verkoopbaar product:** ga niet zelf een kastje 3D-printen op schaal. Kies een
  **white-label AI-voicerecorder** (ODM) die al CE/FCC-gecertificeerd is én met een
  magnetische clip/MagSafe-puck wordt geleverd, en laat die onder salesUp-merk
  bedrukken. Wij hoeven alleen de firmware/upload op ons ingest-endpoint te richten.
  Dat is sneller, goedkoper en juridisch veiliger dan eigen hardware certificeren.

> Tip: een MagSafe-bevestiging werkt out-of-the-box op iPhone 12+. Op Android (of
> oudere iPhones) plak je eenmalig een dunne metalen/magneet-sticker op het toestel
> of de hoes; daarna klikt het device er magnetisch op.

## Stuklijst prototype (±€20)

- **Seeed Studio XIAO ESP32S3 Sense** (~€14) — ESP32-S3 met ingebouwde PDM-microfoon
  en microSD-slot, ter grootte van een duimnagel
- microSD-kaart 8–32 GB (~€5)
- LiPo-batterij 3,7 V 500 mAh (~€5, soldeert op de XIAO) + drukknop + LED
- Behuizing: 3D-print of een Tic-Tac-doosje voor het allereerste prototype

## Hoe het werkt (firmware in `firmware/`)

1. **Knop indrukken** → LED aan → opname start (16 kHz mono WAV naar microSD).
   De knop is meteen de consent-handeling: één druk = bewust opnemen
   (gelogd als `device_button` in de consent-log).
2. **Nog eens drukken** → opname stopt.
3. Zodra het device zijn **WiFi** ziet (kantoor/thuis/hotspot): per bestand
   `action: start` naar de ingest-functie (header `X-Device-Token`), HTTP PUT van de
   WAV naar de signed URL, `action: complete`. Daarna verwijdert het device het
   bestand van de SD-kaart.
4. De rest is bestaand platform: transcriptie (≤10 min later), samenvatting +
   actielijst per mail, en doorzet naar het trainingsplatform.

## Device registreren

Token zelf kiezen (lange random string), dan in Supabase Studio (project
salesup-capture) de hash registreren — zie `supabase/seed_first_org.sql`, blok
"hardware-device registreren". Het token gaat in `firmware/secrets.h` op het device;
in de database staat alleen de sha256-hash. Intrekken = `is_active=false`.

## Flashen

Arduino IDE → board "XIAO_ESP32S3" (espressif/arduino-esp32 ≥ 3.0) →
`firmware/capture_recorder/capture_recorder.ino` openen → `secrets.h` invullen
(WiFi + device-token) → uploaden.
