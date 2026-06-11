// salesUp Capture — desktop (fase 2)
//
// Twee capture-modi, automatisch gekozen:
//  A. Recall.ai Desktop SDK (volledige systeemaudio, detectie van Zoom, Google
//     Meet, Teams, Slack — zonder bot). Actief zodra het npm-package
//     @recallai/desktop-sdk geïnstalleerd is én RECALL_API_KEY als Edge
//     Function secret staat (token wordt server-side aangemaakt).
//  B. Fallback (Plaud-principe): microfoon-opname + eigen procesdetectie van
//     meeting-apps. Werkt zonder Recall-account.
//
// De app draait in de menubalk/tray en joint nooit de meeting.

const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain } = require('electron');
const { exec } = require('child_process');
const path = require('path');

// Regio van je Recall-account (us-west-2 is de default bij Recall;
// pas aan als je key in een andere regio is aangemaakt).
const RECALL_SDK_API_URL = process.env.RECALL_API_URL || 'https://us-west-2.recall.ai';

let RecallAiSdk = null;
try { RecallAiSdk = require('@recallai/desktop-sdk'); } catch (_) { /* fallback-modus B */ }

let win = null;
let tray = null;
let meetingActive = false;
let recordingState = 'idle'; // gespiegeld vanuit de renderer

// Recall-staat: per meeting-window het realtime-transcript en metadata
const recall = { segments: {}, tokens: {}, titles: {} };

const MEETING_PROCESSES = [
  { match: /zoom\.us|Zoom\.exe|CptHost/i, platform: 'zoom' },
  { match: /Microsoft Teams|ms-teams|Teams\.exe/i, platform: 'teams' },
  { match: /Webex|ptoneclk/i, platform: 'webex' },
  { match: /Slack.*huddle/i, platform: 'slack' },
];

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 700,
    resizable: false,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('renderer.html');
  win.on('close', (e) => {
    // naar tray i.p.v. afsluiten — opnames mogen niet sneuvelen door een kruisje
    if (recordingState === 'recording') {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAVklEQVQ4y2NgGAWjYBSMAv0DxgYGhv8EMSOaASYGBgb/CWADhmEYxn8C2AA1DEDXjG4ARQaQ5AVKDSDJC5QaQJIXKDWAJC9QagBJXqDUAJK8MApGwSgAAJxlEgGq5fpRAAAAAElFTkSuQmCC'
  );
  tray = new Tray(icon);
  tray.setToolTip('salesUp Capture');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open salesUp Capture', click: () => { win.show(); } },
    { type: 'separator' },
    { label: 'Afsluiten', click: () => { app.exit(0); } },
  ]));
  tray.on('click', () => win.show());
}

function notifyMeeting(platform, onClick) {
  const n = new Notification({
    title: 'Meeting gedetecteerd',
    body: `Er lijkt een ${platform}-meeting te starten. Klik om de opname te starten.`,
  });
  n.on('click', () => { win.show(); onClick && onClick(); });
  n.show();
}

// ── Modus A: Recall.ai Desktop SDK ──────────────────────────────────────────
function initRecallSdk() {
  RecallAiSdk.init({ api_url: RECALL_SDK_API_URL });

  RecallAiSdk.addEventListener('meeting-detected', (evt) => {
    const windowId = evt.window?.id;
    const platform = evt.window?.platform || 'meeting';
    if (!windowId) return;
    recall.segments[windowId] = recall.segments[windowId] || [];
    notifyMeeting(platform, () =>
      win.webContents.send('recall-meeting-detected', { windowId, platform, viaClick: true }));
    win.webContents.send('recall-meeting-detected', { windowId, platform, viaClick: false });
  });

  RecallAiSdk.addEventListener('meeting-updated', (evt) => {
    const windowId = evt.window?.id;
    if (windowId && evt.window?.title) {
      recall.titles[windowId] = evt.window.title;
      win.webContents.send('recall-meeting-updated', { windowId, title: evt.window.title });
    }
  });

  RecallAiSdk.addEventListener('realtime-event', (evt) => {
    if (evt.event !== 'transcript.data' || !evt.data?.data) return;
    const windowId = evt.window?.id;
    if (!windowId) return;
    const words = evt.data.data.words || [];
    if (words.length === 0) return;
    const speaker = evt.data.data.participant?.name || null;
    const text = words.map((w) => w.text).join(' ').trim();
    if (!text) return;
    (recall.segments[windowId] = recall.segments[windowId] || []).push({
      speaker, text, start_s: null, end_s: null,
    });
  });

  RecallAiSdk.addEventListener('recording-ended', async (evt) => {
    const windowId = evt.window?.id;
    if (!windowId) return;
    // audio naar Recall-cloud (transcript hebben we al realtime binnen)
    try {
      await RecallAiSdk.uploadRecording({ windowId, uploadToken: recall.tokens[windowId] });
    } catch (e) { console.error('uploadRecording:', e); }
    win.webContents.send('recall-recording-ended', {
      windowId,
      segments: recall.segments[windowId] || [],
      title: recall.titles[windowId] || null,
    });
    delete recall.segments[windowId];
    delete recall.tokens[windowId];
  });

  RecallAiSdk.addEventListener('error', (evt) => {
    console.error('RecallAI SDK error:', evt);
    win.webContents.send('recall-error', { message: `${evt.type}: ${evt.message}` });
  });
}

ipcMain.handle('recall-available', () => !!RecallAiSdk);
ipcMain.handle('recall-start', async (_e, { windowId, uploadToken }) => {
  recall.tokens[windowId] = uploadToken;
  await RecallAiSdk.startRecording({ windowId, uploadToken });
  return true;
});
ipcMain.handle('recall-stop', async (_e, { windowId }) => {
  await RecallAiSdk.stopRecording({ windowId });
  return true;
});

// ── Modus B: fallback-procesdetectie (alleen zonder Recall SDK) ─────────────
function pollMeetings() {
  const cmd = process.platform === 'win32' ? 'tasklist' : 'ps -axo comm=,args=';
  exec(cmd, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    if (err) return;
    const hit = MEETING_PROCESSES.find((m) => m.match.test(stdout));
    const nowActive = !!hit;
    if (nowActive && !meetingActive && recordingState === 'idle') {
      notifyMeeting(hit.platform, () =>
        win.webContents.send('meeting-detected', { platform: hit.platform }));
      win.webContents.send('meeting-hint', { platform: hit.platform });
    }
    if (!nowActive && meetingActive && recordingState === 'recording') {
      win.webContents.send('meeting-ended', {});
    }
    meetingActive = nowActive;
  });
}

ipcMain.on('recording-state', (_e, state) => {
  recordingState = state;
  if (tray) tray.setToolTip(state === 'recording' ? 'salesUp Capture — ● OPNAME LOOPT' : 'salesUp Capture');
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  if (RecallAiSdk) {
    initRecallSdk();
  } else {
    setInterval(pollMeetings, 10_000);
    pollMeetings();
  }
});

app.on('window-all-closed', (e) => e.preventDefault());
