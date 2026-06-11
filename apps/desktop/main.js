// salesUp Capture — desktop (fase 2, MVP)
//
// Botloze meeting-opname volgens het Plaud-principe: opnemen via de microfoon
// van de laptop (vangt het hele gesprek bij speakers; bij een headset alleen de
// eigen kant — zie README, upgradepad = Recall.ai Desktop SDK voor volledige
// systeemaudio zodra er een account is).
//
// Automatische detectie: pollt elke 10 s de draaiende processen op
// Zoom/Teams/Webex/Slack. Zodra een meeting-app actief wordt → notificatie
// "Meeting gedetecteerd — opname starten?" → één klik start de opname.
// De app draait in de menubalk/tray, niet ín de meeting.

const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain } = require('electron');
const { exec } = require('child_process');
const path = require('path');

let win = null;
let tray = null;
let meetingActive = false;
let recordingState = 'idle'; // gespiegeld vanuit de renderer

const MEETING_PROCESSES = [
  { match: /zoom\.us|Zoom\.exe|CptHost/i, platform: 'zoom' },
  { match: /Microsoft Teams|ms-teams|Teams\.exe/i, platform: 'teams' },
  { match: /Webex|ptoneclk/i, platform: 'webex' },
  { match: /Slack.*huddle/i, platform: 'slack' },
];

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 640,
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
  // 16x16 oranje stip als tray-icoon (geen asset-bestanden nodig voor de MVP)
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

function pollMeetings() {
  const cmd = process.platform === 'win32' ? 'tasklist' : 'ps -axo comm=,args=';
  exec(cmd, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    if (err) return;
    const hit = MEETING_PROCESSES.find((m) => m.match.test(stdout));
    const nowActive = !!hit;
    if (nowActive && !meetingActive && recordingState === 'idle') {
      const n = new Notification({
        title: 'Meeting gedetecteerd',
        body: `Er lijkt een ${hit.platform}-meeting te starten. Klik om de opname te starten.`,
      });
      n.on('click', () => {
        win.show();
        win.webContents.send('meeting-detected', { platform: hit.platform });
      });
      n.show();
      win.webContents.send('meeting-hint', { platform: hit.platform });
    }
    if (!nowActive && meetingActive && recordingState === 'recording') {
      // meeting-app gestopt terwijl we opnemen → seintje aan de renderer
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
  setInterval(pollMeetings, 10_000);
  pollMeetings();
});

app.on('window-all-closed', (e) => e.preventDefault());
