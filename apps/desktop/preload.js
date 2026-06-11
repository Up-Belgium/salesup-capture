const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  onMeetingDetected: (cb) => ipcRenderer.on('meeting-detected', (_e, d) => cb(d)),
  onMeetingHint: (cb) => ipcRenderer.on('meeting-hint', (_e, d) => cb(d)),
  onMeetingEnded: (cb) => ipcRenderer.on('meeting-ended', (_e, d) => cb(d)),
  setRecordingState: (state) => ipcRenderer.send('recording-state', state),
});
