# salesUp Capture — desktop-app (fase 2, MVP)

Botloze opname van videocalls: de app draait in de menubalk/tray, joint **nooit** de
meeting, detecteert automatisch dat een meeting start en neemt op via de microfoon —
exact het principe waarmee Plaud werkt (audio capteren naast de meeting, niet erin).

## Wat de MVP doet

- **Automatische meetingdetectie**: pollt elke 10 s de draaiende processen op
  Zoom / Microsoft Teams / Webex / Slack-huddles. Bij detectie → systeemnotificatie
  *"Meeting gedetecteerd — opname starten?"*; één klik start de opname (consent-vink
  vereist). Google Meet draait in de browser en is niet via processen te zien —
  daarvoor start je handmatig (of later via de Recall-SDK, zie onder).
- **Opname via microfoon** (MediaRecorder, webm/opus). Met speakers hoor je beide
  kanten in de opname; met een headset alleen de eigen kant — zie *Upgradepad*.
- **Upload** naar de capture-pipeline via de gebruikers-JWT (login = bestaand
  platform-account; geen geheimen in de app), daarna automatische transcriptie
  (02:45) en AI-analyse (03:00) zoals elke andere opname.
- Tray-tooltip toont **● OPNAME LOOPT**; het venster sluiten tijdens een opname
  verbergt de app alleen (opname loopt door).

## Draaien

```bash
cd capture-desktop
npm install
npm start          # Electron-venster + tray
npm run dist       # installers (dmg/exe) via electron-builder
```

macOS vraagt bij de eerste opname om microfoontoegang (Systeeminstellingen →
Privacy → Microfoon).

## Upgradepad: Recall.ai Desktop Recording SDK (de "volwaardige" fase 2)

De MVP vangt met een headset alleen de eigen spreker. De structurele oplossing is de
[Recall.ai Desktop Recording SDK](https://www.recall.ai/product/desktop-recording-sdk)
($0,50/opname-uur): volledige systeemaudio + per-spreker transcript + betrouwbare
meetingdetectie voor Zoom/Meet/Teams/Webex/Slack, zonder bot. Integratiepunten zijn
er al:

1. Recall-webhook → edge function `ingest-recording`, action `transcript` met header
   `X-Capture-Secret` (dan is zelfs onze eigen ASR-stap niet nodig).
2. `meeting_platform` en `external_ref` (Recall recording-id) bestaan al als kolommen.

Nodig van Stig: Recall.ai-account + API-key, en `CAPTURE_INGEST_SECRET` als Edge
Function secret.
