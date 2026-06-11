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
let detectedPlatform = null;
let autoStarted = false;   // opname gestart door meetingdetectie (staande consent)

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
  show('mainView');
}

// ── Opname ───────────────────────────────────────────────────────────────────
async function startRecording(opts = {}) {
  // handmatig: per-gesprek consent-vink; automatisch: de staande
  // autorec-instelling ís de consentbevestiging (zie label in de UI)
  if (!opts.auto && !$('consent').checked) {
    setMsg('mainMsg', 'Bevestig eerst de consent-verklaring.', 'err');
    return;
  }
  if (opts.auto && (!$('autorec').checked || mediaRecorder?.state === 'recording')) return;
  autoStarted = !!opts.auto;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  chunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  mediaRecorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  mediaRecorder.start(1000);
  seconds = 0;
  $('timer').style.display = 'block';
  timerHandle = setInterval(() => {
    seconds += 1;
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    $('timer').textContent = `${mm}:${ss}`;
  }, 1000);
  window.capture.setRecordingState('recording');
  show('recView');
}

async function stopAndUpload() {
  clearInterval(timerHandle);
  window.capture.setRecordingState('idle');
  setMsg('recMsg', 'Versturen…', 'ok');

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
    setMsg('mainMsg', 'Opname verstuurd — transcriptie en analyse volgen automatisch.', 'ok');
  } catch (e) {
    setMsg('mainMsg', `Versturen mislukt: ${e.message}`, 'err');
  } finally {
    $('consent').checked = false;
    $('title').value = '';
    detectedPlatform = null;
    autoStarted = false;
    $('timer').style.display = 'none';
    show('mainView');
  }
}

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
$('stopBtn').addEventListener('click', () => stopAndUpload());
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
  setMsg('hint', `${platform}-meeting gedetecteerd — klaar om op te nemen.`, 'hint');
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
      setMsg('recMsg', 'Meeting-app gestopt — vergeet niet op "Stop & verstuur" te klikken.', 'hint');
    }
  }
});

// autorec-voorkeur bewaren
$('autorec').addEventListener('change', () => {
  localStorage.setItem('capture.autorec', $('autorec').checked ? '1' : '');
});

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
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
