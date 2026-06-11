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

## Recall-modus (volledige systeemaudio + Google Meet) — INGEBOUWD

De [Recall Desktop SDK](https://www.recall.ai/product/desktop-recording-sdk)-integratie
($0,50/opname-uur) zit volledig in de code: backend-acties `recall_start` (maakt
server-side het sdk_upload-token, key blijft geheim) en `recall_transcript`
(realtime-transcript), plus de SDK-afhandeling in `main.js`. De app kiest automatisch:
SDK-package aanwezig → Recall-modus (systeemaudio, detectie van Zoom/**Google Meet**/
Teams/Slack, per-spreker transcript zonder eigen ASR-stap); afwezig → de
microfoon-fallback hierboven. Activeren:

1. Zet `RECALL_API_KEY` als Edge Function secret op het Supabase-project
   `salesup-capture` (en `RECALL_API_URL` als je key niet in us-west-2 staat —
   check de regio in je Recall-dashboard).
2. In deze map: `npm install @recallai/desktop-sdk`, dan `npm start`
   (of `npm run dist` voor een nieuwe .app).
3. Recall-opnames gaan met provider `recall_sdk` rechtstreeks de pipeline in;
   Deepgram wordt voor die opnames overgeslagen, samenvatting + mail werken identiek.
