// salesUp Capture desktop — renderer: login (Supabase Auth), opname via
// MediaRecorder (microfoon, Plaud-principe) en upload naar de capture-pipeline.
// Geen geheimen in de app: de anon key is publiek, alle autorisatie loopt via
// de gebruikers-JWT die ingest-recording server-side valideert.

const SUPABASE_URL = 'https://plbuczbxtauhuobkicdr.supabase.co';
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsYnVjemJ4dGF1aHVvYmtpY2RyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNjA1NTcsImV4cCI6MjA5NjczNjU1N30.5hIzTuUvHYYxfnGxjM0IZmOxLwB0pDlo9_HCTsVcO-I';
const INGEST_URL = `${SUPABASE_URL}/functions/v1/ingest-recording`;

const $ = (id) => document.getElementById(id);
let session = null;           // { access_token, refresh_token, expires_at }
let ctx = null;               // { orgs, member_by_org }
let mediaRecorder = null;
let chunks = [];
let seconds = 0;
let timerHandle = null;
let paused = false;
let detectedPlatform = null;
let autoStarted = false;   // opname gestart door meetingdetectie (staande consent)
let hasRecallSdk = false;  // Recall Desktop SDK aanwezig in de main-process?
const recallSt = { windowId: null, recordingId: null, active: false, title: null };

// ── Auth (plain fetch — geen SDK nodig in de renderer) ──────────────────────
async function authFetch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.msg || 'Auth-fout');
  return json;
}

async function login(email, password) {
  const json = await authFetch('token?grant_type=password', { email, password });
  session = json;
  localStorage.setItem('capture.session', JSON.stringify(session));
}

async function freshToken() {
  if (!session) throw new Error('Niet ingelogd');
  const expiresAt = (session.expires_at || 0) * 1000;
  if (Date.now() < expiresAt - 60_000) return session.access_token;
  const json = await authFetch('token?grant_type=refresh_token', {
    refresh_token: session.refresh_token,
  });
  session = json;
  localStorage.setItem('capture.session', JSON.stringify(session));
  return session.access_token;
}

async function ingest(action, body) {
  const token = await freshToken();
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(json.error || `Fout (${res.status})`);
  return json;
}

// ── Views ────────────────────────────────────────────────────────────────────
function show(view) {
  ['loginView', 'mainView', 'recView'].forEach((v) => ($(v).style.display = v === view ? 'block' : 'none'));
}

// Golfvorm tijdens de opname (decoratief) en timer die pauzes overslaat.
$('recWave').innerHTML = Array.from({ length: 44 }, (_, i) =>
  `<i style="height:${30 + ((i * 37) % 70)}%;animation-delay:${-((i * 113) % 1100)}ms"></i>`).join('');
function renderTimer() {
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  $('timer').textContent = `${mm}:${ss}`;
}
function startTimer() {
  seconds = 0; paused = false;
  renderTimer();
  $('timer').style.display = 'block';
  clearInterval(timerHandle);
  timerHandle = setInterval(() => { if (!paused) { seconds += 1; renderTimer(); } }, 1000);
}
function setPausedUi(p) {
  paused = p;
  $('livePill').textContent = p ? 'Gepauzeerd' : 'Opname loopt';
  $('livePill').classList.toggle('paused', p);
  $('recWave').classList.toggle('paused', p);
  $('pauseBtn').querySelector('span').textContent = p ? 'Hervat' : 'Pauze';
  $('pauseBtn').querySelector('use').setAttribute('href', p ? '#i-play' : '#i-pause');
}
function enterRecView(title, canPause) {
  const client = ctx && ctx.orgs.length > 1 ? $('client').selectedOptions[0]?.textContent : '';
  $('recSub').textContent = [title, client].filter(Boolean).join(' · ');
  $('pauseBtn').style.display = canPause ? '' : 'none';
  setPausedUi(false);
  setMsg('recMsg', '', '');
  show('recView');
}

async function enterMain() {
  ctx = await ingest('context', {});
  $('autorec').checked = localStorage.getItem('capture.autorec') === '1';
  const sel = $('client');
  sel.innerHTML = '';
  for (const c of ctx.orgs) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    sel.appendChild(o);
  }
  $('clientWrap').style.display = ctx.orgs.length > 1 ? 'block' : 'none';
  $('who').textContent = session?.user?.user_metadata?.full_name || session?.user?.email || '';
  show('mainView');
  refreshCalStatus();
}

// ── Opname ───────────────────────────────────────────────────────────────────
async function startRecording(opts = {}) {
  // handmatig: per-gesprek consent-vink; automatisch: de staande
  // autorec-instelling ís de consentbevestiging (zie label in de UI)
  if (!opts.auto && !$('consent').checked) {
    setMsg('mainMsg', 'Bevestig eerst de consent-verklaring.', 'err');
    return;
  }
  if (opts.auto && (!$('autorec').checked || mediaRecorder?.state === 'recording' || recallSt.active)) return;
  autoStarted = !!opts.auto;
  // Recall-modus: gedetecteerde meeting + SDK aanwezig → systeemaudio-opname
  if (hasRecallSdk && recallSt.windowId && !recallSt.active) return recallBegin();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  chunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  mediaRecorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  mediaRecorder.start(1000);
  startTimer();
  window.capture.setRecordingState('recording');
  enterRecView($('title').value.trim() || (detectedPlatform ? `${detectedPlatform}-meeting` : ''), true);
}

async function stopAndUpload() {
  clearInterval(timerHandle);
  window.capture.setRecordingState('idle');
  setMsg('recMsg', 'Versturen…', 'ok');
  $('stopBtn').disabled = true; $('pauseBtn').disabled = true;

  await new Promise((resolve) => {
    mediaRecorder.onstop = resolve;
    mediaRecorder.stop();
  });
  mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: 'audio/webm' });

  try {
    const startedAt = new Date(Date.now() - seconds * 1000).toISOString();
    const startJson = await ingest('start', {
      org_id: $('client').value || (ctx.orgs[0] && ctx.orgs[0].id),
      recording_type: 'video_meeting',
      meeting_platform: detectedPlatform,
      title: $('title').value || null,
      started_at: startedAt,
      ext: 'webm',
    });
    const up = await fetch(startJson.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/webm', 'x-upsert': 'false' },
      body: blob,
    });
    if (!up.ok) throw new Error(`Upload geweigerd (${up.status})`);
    await ingest('complete', {
      recording_id: startJson.recording_id,
      ended_at: new Date().toISOString(),
      duration_seconds: seconds,
      consent_status: 'informed',
      consent_method: 'app_notice',
      consent_details: autoStarted
        ? 'Automatisch gestart bij meetingdetectie; staande consent-instelling actief.'
        : 'Bevestigd in de desktop-app vóór de start van de opname.',
    });
    setMsg('mainMsg', 'Opname verstuurd. Je krijgt het verslag per mail.', 'ok');
  } catch (e) {
    setMsg('mainMsg', `Versturen mislukt: ${e.message}`, 'err');
  } finally {
    $('consent').checked = false;
    $('title').value = '';
    detectedPlatform = null;
    autoStarted = false;
    $('timer').style.display = 'none';
    $('stopBtn').disabled = false; $('pauseBtn').disabled = false;
    show('mainView');
  }
}

$('pauseBtn').addEventListener('click', () => {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  if (mediaRecorder.state === 'recording') { mediaRecorder.pause(); setPausedUi(true); }
  else if (mediaRecorder.state === 'paused') { mediaRecorder.resume(); setPausedUi(false); }
});

function setMsg(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = `msg ${cls || ''}`;
}

// ── Events ───────────────────────────────────────────────────────────────────
$('loginBtn').addEventListener('click', async () => {
  try {
    $('loginBtn').disabled = true;
    await login($('email').value.trim(), $('password').value);
    await enterMain();
  } catch (e) {
    setMsg('loginMsg', `Inloggen mislukt: ${e.message}`, 'err');
  } finally {
    $('loginBtn').disabled = false;
  }
});

$('startBtn').addEventListener('click', () => startRecording().catch((e) => setMsg('mainMsg', e.message, 'err')));

// ── Agenda verbinden (Google OAuth via calendar-oauth) ──────────────────────
async function refreshCalStatus() {
  try {
    const s = await calOAuth('status');
    if (s.connected) {
      const plat = s.calendar_platform === 'microsoft_outlook' ? 'Outlook' : 'Google';
      const next = await nextMeeting();
      $('calStatus').className = 'ok';
      $('calStatus').innerHTML = '<svg><use href="#i-check"/></svg><span></span>';
      $('calStatus').querySelector('span').textContent = next
        ? `Volgende: ${next.title || 'meeting'} · ${new Date(next.started_at).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}`
        : `Agenda verbonden via ${plat}${s.calendar_email ? ` (${s.calendar_email})` : ''}. De bot komt vanzelf in je videocalls.`;
      $('calBtn').textContent = 'Agenda ontkoppelen';
      $('calBtn').dataset.connected = '1';
      $('calBtnMs').style.display = 'none';
    } else {
      $('calStatus').className = 'muted';
      $('calStatus').textContent = 'Verbind je agenda, dan komt de bot vanzelf in je geplande videocalls.';
      $('calBtn').textContent = 'Google Agenda verbinden';
      $('calBtn').dataset.connected = '';
      $('calBtnMs').style.display = '';
    }
  } catch (_) {}
}
// Eerstvolgende ingeplande bot-opname uit de agenda (RLS: enkel eigen opnames).
async function nextMeeting() {
  try {
    const token = await freshToken();
    const q = `select=title,started_at&status=eq.pending_upload&started_at=gt.${encodeURIComponent(new Date().toISOString())}&order=started_at.asc&limit=1`;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/recordings?${q}`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } });
    const rows = await res.json();
    return Array.isArray(rows) && rows[0] && new Date(rows[0].started_at).toDateString() === new Date().toDateString() ? rows[0] : null;
  } catch (_) { return null; }
}
// calendar-oauth heeft een eigen endpoint; we hergebruiken ingest() niet (andere functie)
async function calOAuth(action, provider) {
  const token = await freshToken();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/calendar-oauth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(provider ? { action, provider } : { action }),
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(json.error || `Fout (${res.status})`);
  return json;
}
$('calBtn').addEventListener('click', async () => {
  try {
    if ($('calBtn').dataset.connected) {
      await calOAuth('disconnect');
      setMsg('mainMsg', 'Agenda ontkoppeld.', 'hint');
    } else {
      const { url } = await calOAuth('auth_url', 'google');
      await window.capture.openExternal(url);
      setMsg('mainMsg', 'Het toestemmingsscherm van Google is geopend in je browser. Na "Toestaan" is je agenda verbonden.', 'hint');
    }
    setTimeout(refreshCalStatus, 1500);
  } catch (e) {
    setMsg('mainMsg', e.message, 'err');
  }
});

$('calBtnMs').addEventListener('click', async () => {
  try {
    const { url } = await calOAuth('auth_url', 'microsoft');
    await window.capture.openExternal(url);
    setMsg('mainMsg', 'Het toestemmingsscherm van Microsoft is geopend in je browser. Na "Toestaan" is je Outlook-agenda verbonden.', 'hint');
    setTimeout(refreshCalStatus, 1500);
  } catch (e) {
    setMsg('mainMsg', e.message, 'err');
  }
});

// ── Zichtbare meeting-bot (Leexi-model) — werkt zonder permissies/SDK ───────
$('botBtn').addEventListener('click', async () => {
  const url = $('botUrl').value.trim();
  if (!url.startsWith('http')) {
    setMsg('mainMsg', 'Plak eerst de volledige link van de meeting.', 'err');
    return;
  }
  $('botBtn').disabled = true;
  try {
    await ingest('bot_start', {
      meeting_url: url,
      org_id: $('client').value || (ctx.orgs[0] && ctx.orgs[0].id),
      title: $('title').value || null,
    });
    $('botUrl').value = '';
    setMsg('mainMsg', 'De bot "salesUp Capture" is onderweg. Laat hem toe in de wachtruimte als dat gevraagd wordt; het verslag volgt per mail.', 'ok');
  } catch (e) {
    setMsg('mainMsg', `Bot sturen mislukt: ${e.message}`, 'err');
  } finally {
    $('botBtn').disabled = false;
  }
});
$('stopBtn').addEventListener('click', () => {
  if (recallSt.active) {
    setMsg('recMsg', 'Opname stoppen en verwerken…', 'ok');
    window.capture.recallStop({ windowId: recallSt.windowId }).catch((e) => setMsg('recMsg', e.message, 'err'));
  } else {
    stopAndUpload();
  }
});

// ── Recall-modus (systeemaudio via Desktop SDK) ─────────────────────────────
async function recallBegin() {
  const json = await ingest('recall_start', {
    org_id: $('client').value || (ctx.orgs[0] && ctx.orgs[0].id),
    meeting_platform: detectedPlatform,
    title: $('title').value || recallSt.title || null,
    started_at: new Date().toISOString(),
  });
  recallSt.recordingId = json.recording_id;
  await window.capture.recallStart({ windowId: recallSt.windowId, uploadToken: json.upload_token });
  recallSt.active = true;
  startTimer();
  window.capture.setRecordingState('recording');
  // De Recall SDK neemt systeemaudio op en kent geen pauze.
  enterRecView($('title').value.trim() || recallSt.title || (detectedPlatform ? `${detectedPlatform}-meeting` : ''), false);
}

window.capture.onRecallMeetingDetected(({ windowId, platform }) => {
  detectedPlatform = platform;
  recallSt.windowId = windowId;
  setMsg('hint', `${platform}-meeting gedetecteerd. Klaar om op te nemen (systeemaudio).`, 'hint');
  if ($('autorec').checked && $('mainView').style.display === 'block' && !recallSt.active) {
    startRecording({ auto: true }).catch((e) => setMsg('mainMsg', e.message, 'err'));
  }
});

window.capture.onRecallMeetingUpdated(({ windowId, title }) => {
  if (windowId === recallSt.windowId) recallSt.title = title;
});

window.capture.onRecallRecordingEnded(async ({ windowId, segments }) => {
  if (windowId !== recallSt.windowId || !recallSt.recordingId) return;
  clearInterval(timerHandle);
  window.capture.setRecordingState('idle');
  try {
    await ingest('complete', {
      recording_id: recallSt.recordingId,
      ended_at: new Date().toISOString(),
      duration_seconds: seconds,
      consent_status: 'informed',
      consent_method: 'app_notice',
      consent_details: autoStarted
        ? 'Automatisch gestart bij meetingdetectie (Recall SDK); staande consent-instelling actief.'
        : 'Bevestigd in de desktop-app vóór de start van de opname (Recall SDK).',
    });
    if (Array.isArray(segments) && segments.length > 0) {
      await ingest('recall_transcript', { recording_id: recallSt.recordingId, segments });
      setMsg('mainMsg', 'Meeting opgenomen en verstuurd. Het verslag volgt per mail.', 'ok');
    } else {
      setMsg('mainMsg', 'Meeting opgenomen. Het transcript volgt via Recall, daarna krijg je het verslag per mail.', 'hint');
    }
  } catch (e) {
    setMsg('mainMsg', `Verwerken mislukt: ${e.message}`, 'err');
  } finally {
    recallSt.windowId = null; recallSt.recordingId = null; recallSt.active = false; recallSt.title = null;
    autoStarted = false;
    $('consent').checked = false;
    $('title').value = '';
    $('timer').style.display = 'none';
    show('mainView');
  }
});

window.capture.onRecallError(({ message }) => setMsg('mainMsg', `Recall SDK: ${message}`, 'err'));

const PERM_NL = {
  'accessibility': 'Toegankelijkheid', 'screen-capture': 'Schermopname',
  'microphone': 'Microfoon', 'system-audio': 'Systeemaudio', 'full-disk-access': 'Volledige schijftoegang',
};
// Status van álle permissies live tonen — macOS-vinkjes van een vorige build
// gelden niet voor een nieuwe build (ongesigneerde app), dus zichtbaarheid is alles.
const permState = {};
window.capture.onRecallPermission(({ permission, status }) => {
  permState[permission] = String(status).toLowerCase();
  const parts = Object.entries(permState).map(([p, s]) =>
    `${PERM_NL[p] || p} ${s === 'granted' ? '✓' : `✗ (${s})`}`);
  const allOk = Object.values(permState).every((s) => s === 'granted');
  setMsg('hint',
    `Permissies: ${parts.join(' · ')}${allOk
      ? '. Alles in orde, meetings worden automatisch gedetecteerd.'
      : '. Klik op de knop hieronder, sta toe wat macOS vraagt, en herstart daarna de app.'}`,
    allOk ? 'hint' : 'err');
  $('permBtn').style.display = allOk ? 'none' : 'block';
});

$('permBtn').addEventListener('click', async () => {
  // 'full-disk-access' is optioneel (alleen Teams-URL-detectie) — niet hervragen
  const missing = Object.entries(permState)
    .filter(([p, s]) => s !== 'granted' && p !== 'full-disk-access')
    .map(([p]) => p);
  for (const p of missing.length ? missing : ['accessibility', 'screen-capture', 'system-audio', 'microphone']) {
    try { await window.capture.recallRequestPermission({ permission: p }); } catch (_) {}
  }
  setMsg('hint', 'Permissies aangevraagd. Sta ze toe in macOS (Systeeminstellingen) en herstart daarna de app.', 'hint');
});
$('logout').addEventListener('click', (e) => {
  e.preventDefault();
  session = null;
  localStorage.removeItem('capture.session');
  show('loginView');
});

window.capture.onMeetingDetected(({ platform }) => {
  detectedPlatform = platform;
  if ($('mainView').style.display === 'block') startRecording({ auto: true }).catch(() => {});
});
window.capture.onMeetingHint(({ platform }) => {
  detectedPlatform = platform;
  setMsg('hint', `${platform}-meeting gedetecteerd. Klaar om op te nemen.`, 'hint');
  // volautomatisch: staande autorec-instelling + ingelogd → meteen starten
  if ($('autorec').checked && $('mainView').style.display === 'block') {
    startRecording({ auto: true }).catch(() => {});
  }
});
window.capture.onMeetingEnded(() => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    if (autoStarted) {
      // automatisch gestart → ook automatisch stoppen en versturen
      stopAndUpload();
    } else {
      setMsg('recMsg', 'De meeting-app is gesloten. Vergeet niet op "Stop & verstuur" te klikken.', 'hint');
    }
  }
});

// autorec-voorkeur bewaren
$('autorec').addEventListener('change', () => {
  localStorage.setItem('capture.autorec', $('autorec').checked ? '1' : '');
});

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  try { hasRecallSdk = await window.capture.recallAvailable(); } catch (_) { hasRecallSdk = false; }
  if (hasRecallSdk) {
    setMsg('hint', 'Recall-modus actief: meetings (Zoom/Meet/Teams/Slack) worden automatisch gedetecteerd via systeemaudio.', 'hint');
  }
  try {
    const stored = localStorage.getItem('capture.session');
    if (stored) {
      session = JSON.parse(stored);
      await enterMain();
      return;
    }
  } catch (_) { /* sessie ongeldig → login */ }
  show('loginView');
})();
