const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  // fallback-modus (procesdetectie + microfoon)
  onMeetingDetected: (cb) => ipcRenderer.on('meeting-detected', (_e, d) => cb(d)),
  onMeetingHint: (cb) => ipcRenderer.on('meeting-hint', (_e, d) => cb(d)),
  onMeetingEnded: (cb) => ipcRenderer.on('meeting-ended', (_e, d) => cb(d)),
  setRecordingState: (state) => ipcRenderer.send('recording-state', state),

  // Recall.ai Desktop SDK-modus (systeemaudio, alle platformen incl. Meet)
  recallAvailable: () => ipcRenderer.invoke('recall-available'),
  recallStart: (args) => ipcRenderer.invoke('recall-start', args),
  recallStop: (args) => ipcRenderer.invoke('recall-stop', args),
  onRecallMeetingDetected: (cb) => ipcRenderer.on('recall-meeting-detected', (_e, d) => cb(d)),
  onRecallMeetingUpdated: (cb) => ipcRenderer.on('recall-meeting-updated', (_e, d) => cb(d)),
  onRecallRecordingEnded: (cb) => ipcRenderer.on('recall-recording-ended', (_e, d) => cb(d)),
  onRecallError: (cb) => ipcRenderer.on('recall-error', (_e, d) => cb(d)),
});
