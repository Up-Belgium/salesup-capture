// Duurzame upload-wachtrij voor opnames (fix/durable-upload).
//
// Waarom: bij het incident van 2026-09-28 faalde de PUT van een opname van
// 75 min. De mislukte upload zat enkel in het geheugen van de app → na het
// sluiten van de app was de retry-knop weg, de opname bleef op pending_upload
// zonder bestand en er kwam nooit een verslag.
//
// Ontwerp:
//  - Eén item per OPNAME (groep), bewaard in AsyncStorage onder capture.queue.v1.
//    Een groep bevat 1..n audiosegmenten (na een onderbreking of een automatische
//    segment-rotatie). Segment 1 = recordings.storage_path, de rest = segment_paths.
//  - Het audiobestand wordt meteen na het stoppen verhuisd van de cache naar
//    documentDirectory/pending/ (de cache mag iOS opruimen bij plaatsgebrek).
//  - processQueue() werkt elke stap af en bewaart na ELKE stap de voortgang, zodat
//    een crash of het sluiten van de app nooit iets verliest:
//      1. geen recordingId → ingest start (met client_ref = localId, idempotent)
//         → recordingId + storagePath van segment 1 METEEN bewaren
//      2. per segment: nog geen pad → append (segment_no, idempotent) → pad
//         bewaren VÓÓR de upload; wel al een pad (retry) → reupload (upsert-URL)
//      3. PUT → segment als geüpload bewaren
//      4. finalized + alles geüpload → ingest complete → completed bewaren →
//         lokale bestanden weg → groep uit de wachtrij
//  - Eén processQueue tegelijk (mutex); een trigger tijdens een run plant een
//    extra run in, zodat nieuw toegevoegde segmenten meteen meegaan.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';
import { INGEST_URL } from './config';

export type QueueRecType = 'in_person' | 'phone' | 'video_meeting';

export type QueueSegment = {
  uri: string;               // lokaal bestand (bij voorkeur in documentDirectory/pending/)
  duration: number;          // seconden
  storagePath: string | null; // pad in de bucket zodra de server het toekende
  uploaded: boolean;
};

export type QueueGroup = {
  localId: string;
  orgId: string;
  recType: QueueRecType;
  title: string | null;
  startedAt: string;
  endedAt?: string | null;
  recordingId: string | null;
  segments: QueueSegment[];
  finalized: boolean;        // opname is gestopt; na de laatste upload volgt complete
  completed: boolean;        // complete is gelukt (enkel nog opruimen)
  attempts: number;
  lastError: string | null;
  updatedAt: string;
  notified?: boolean;        // lokale melding "nog niet verstuurd" al getoond
  missingFile?: boolean;     // audiobestand is niet meer op het toestel → onherstelbaar
  rescued?: boolean;         // teruggevonden bestand (orphan recovery)
};

export type QueueState = {
  busy: boolean;
  progress: { localId: string; segment: number; sent: number; total: number } | null;
};

const QUEUE_KEY = 'capture.queue.v1';
const CURRENT_KEY = 'capture.currentGroup.v1';
export const PENDING_DIR = (FileSystem.documentDirectory ?? '') + 'pending/';

// ── ingest-helper (gedeeld met App.tsx) ──────────────────────────────────────
export class IngestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function ingest(action: string, body: Record<string, unknown>, token: string) {
  // Time-out: een hangende request mag de wachtrij (mutex) niet eeuwig blokkeren.
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...body }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    throw new Error(e?.name === 'AbortError' ? 'Server reageert niet (time-out)' : `Geen verbinding (${e?.message ?? e})`);
  } finally { clearTimeout(to); }
  let json: any = {};
  try { json = await res.json(); } catch { /* geen JSON (bv. gateway-fout) */ }
  if (!res.ok || json.ok === false) throw new IngestError(json.error || `Fout (${res.status})`, res.status);
  return json;
}

// ── opslag + serialisatie ────────────────────────────────────────────────────
let cache: QueueGroup[] | null = null;
let chain: Promise<unknown> = Promise.resolve();
let state: QueueState = { busy: false, progress: null };
const listeners = new Set<(q: QueueGroup[], s: QueueState) => void>();

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

async function load(): Promise<QueueGroup[]> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? parsed : [];
  } catch { cache = []; }
  return cache;
}

function emit() {
  const q = clone(cache ?? []);
  for (const l of listeners) { try { l(q, state); } catch { /* UI-listener */ } }
}

// Alle wijzigingen lopen na elkaar (lezen → aanpassen → wegschrijven), zodat de
// recorder en processQueue elkaars wijzigingen nooit overschrijven.
function mutate(fn: (q: QueueGroup[]) => void): Promise<QueueGroup[]> {
  const next = chain.then(async () => {
    const q = clone(await load());
    fn(q);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    cache = q;
    emit();
    return q;
  });
  chain = next.catch(() => {});
  return next;
}

function mutateGroup(localId: string, fn: (g: QueueGroup) => void) {
  return mutate((q) => {
    const g = q.find((x) => x.localId === localId);
    if (g) { fn(g); g.updatedAt = new Date().toISOString(); }
  });
}

export async function getQueue(): Promise<QueueGroup[]> {
  await chain;
  return clone(await load());
}

export function subscribe(listener: (q: QueueGroup[], s: QueueState) => void): () => void {
  listeners.add(listener);
  load().then(() => listener(clone(cache ?? []), state)).catch(() => {});
  return () => { listeners.delete(listener); };
}

function setState(patch: Partial<QueueState>) {
  state = { ...state, ...patch };
  emit();
}

export function newLocalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── huidige opname-groep (overleeft een herstart van de app) ─────────────────
export async function setCurrentGroupId(localId: string | null) {
  try {
    if (localId) await AsyncStorage.setItem(CURRENT_KEY, localId);
    else await AsyncStorage.removeItem(CURRENT_KEY);
  } catch { /* best-effort */ }
}

export async function getCurrentGroupId(): Promise<string | null> {
  try { return await AsyncStorage.getItem(CURRENT_KEY); } catch { return null; }
}

// ── bestanden ────────────────────────────────────────────────────────────────
// Verhuist een opnamebestand naar documentDirectory/pending/<localId>-<n>.<ext>.
// Valt terug op kopiëren; lukt ook dat niet, dan blijft het originele pad.
async function persistFile(uri: string, localId: string, n: number): Promise<string> {
  if (!FileSystem.documentDirectory || uri.startsWith(PENDING_DIR)) return uri;
  const ext = (uri.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'm4a').toLowerCase();
  const target = `${PENDING_DIR}${localId}-${n}.${ext}`;
  try { await FileSystem.makeDirectoryAsync(PENDING_DIR, { intermediates: true }); } catch { /* bestaat al */ }
  try {
    await FileSystem.moveAsync({ from: uri, to: target });
    return target;
  } catch { /* verhuizen mislukt → kopiëren */ }
  try {
    await FileSystem.copyAsync({ from: uri, to: target });
    const info = await FileSystem.getInfoAsync(target);
    if (info.exists) {
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      return target;
    }
  } catch { /* ook kopiëren mislukt */ }
  return uri;
}

// ── wachtrij vullen ──────────────────────────────────────────────────────────
type GroupMeta = { localId: string; orgId: string; recType: QueueRecType; title: string | null; startedAt: string };

// Voegt een afgewerkt audiosegment toe aan (een nieuwe of bestaande) groep.
// finalize=true: dit was het laatste segment (Stop & verstuur).
export async function enqueueSegment(meta: GroupMeta, uri: string, duration: number, finalize: boolean) {
  const existing = (await getQueue()).find((g) => g.localId === meta.localId);
  const n = (existing?.segments.length ?? 0) + 1;
  const persisted = await persistFile(uri, meta.localId, n);
  const now = new Date().toISOString();
  await mutate((q) => {
    let g = q.find((x) => x.localId === meta.localId);
    if (!g) {
      g = {
        localId: meta.localId, orgId: meta.orgId, recType: meta.recType, title: meta.title,
        startedAt: meta.startedAt, endedAt: null, recordingId: null, segments: [],
        finalized: false, completed: false, attempts: 0, lastError: null, updatedAt: now,
      };
      q.push(g);
    }
    if (!g.segments.some((s) => s.uri === persisted)) {
      g.segments.push({ uri: persisted, duration: Math.max(0, Math.round(duration)), storagePath: null, uploaded: false });
    }
    if (finalize) { g.finalized = true; g.endedAt = now; }
    g.updatedAt = now;
  });
}

// Sluit een groep af zonder nieuw segment (bv. "Klaar, stoppen" na een onderbreking).
export async function finalizeGroup(localId: string) {
  await mutateGroup(localId, (g) => { if (!g.finalized) { g.finalized = true; g.endedAt = new Date().toISOString(); } });
}

// Teruggevonden bestand als groep toevoegen. Met recordingId/storagePath (redding
// van een bestaande pending_upload-opname) gaat de upload via reupload naar
// exact het pad waar de server het bestand verwacht.
export async function enqueueRescued(opts: {
  uri: string; orgId: string; recType: QueueRecType; title: string | null; startedAt: string;
  duration: number; recordingId?: string | null; storagePath?: string | null;
}) {
  const localId = newLocalId();
  const persisted = await persistFile(opts.uri, localId, 1);
  const now = new Date().toISOString();
  await mutate((q) => {
    q.push({
      localId, orgId: opts.orgId, recType: opts.recType, title: opts.title, startedAt: opts.startedAt,
      endedAt: now, recordingId: opts.recordingId ?? null,
      segments: [{ uri: persisted, duration: Math.max(0, Math.round(opts.duration)), storagePath: opts.recordingId ? (opts.storagePath ?? null) : null, uploaded: false }],
      finalized: true, completed: false, attempts: 0, lastError: null, updatedAt: now, rescued: true,
    });
  });
  return localId;
}

// Groep verwijderen (enkel voor onherstelbare items of na afronden).
export async function removeGroup(localId: string, deleteFiles: boolean) {
  const g = (await getQueue()).find((x) => x.localId === localId);
  if (g && deleteFiles) {
    for (const s of g.segments) await FileSystem.deleteAsync(s.uri, { idempotent: true }).catch(() => {});
  }
  await mutate((q) => { const i = q.findIndex((x) => x.localId === localId); if (i >= 0) q.splice(i, 1); });
}

// ── verwerken ────────────────────────────────────────────────────────────────
type Deps = { getToken: () => Promise<string | null> };

let running: Promise<void> | null = null;
let again = false;

export function processQueue(deps: Deps): Promise<void> {
  if (running) { again = true; return running; }
  running = (async () => {
    setState({ busy: true });
    try {
      do { again = false; await runOnce(deps); } while (again);
    } finally {
      running = null;
      setState({ busy: false, progress: null });
    }
  })();
  return running;
}

async function runOnce(deps: Deps) {
  const q = await getQueue();
  for (const { localId } of q) {
    // Token per groep ophalen: een lange upload kan langer duren dan de JWT geldig is.
    const token = await deps.getToken();
    if (!token) return; // geen sessie: later opnieuw (bij volgende trigger)
    try {
      await processGroup(localId, token);
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      await mutateGroup(localId, (g) => { g.attempts += 1; g.lastError = msg; });
      await maybeNotify([localId], false);
    }
  }
}

async function findGroup(localId: string) {
  return (await getQueue()).find((g) => g.localId === localId) ?? null;
}

async function processGroup(localId: string, token: string) {
  let g = await findGroup(localId);
  if (!g) return;
  if (g.completed) { await cleanup(g); return; }
  if (g.segments.length === 0) { if (g.finalized) await removeGroup(localId, false); return; }
  if (g.missingFile) return; // onherstelbaar; de gebruiker kan het item verwijderen

  // Bestaan alle nog te versturen bestanden nog?
  for (const s of g.segments) {
    if (s.uploaded) continue;
    const info = await FileSystem.getInfoAsync(s.uri);
    if (!info.exists) {
      await mutateGroup(localId, (x) => { x.missingFile = true; x.lastError = 'Audiobestand niet meer gevonden op dit toestel.'; });
      return;
    }
  }

  // 1 · opname aanmaken (idempotent via client_ref) en METEEN bewaren
  let fresh: { path: string; url: string; upsert: boolean } | null = null;
  if (!g.recordingId) {
    const st = await ingest('start', {
      org_id: g.orgId, recording_type: g.recType, title: g.title,
      started_at: g.startedAt, ext: 'm4a', client_ref: g.localId,
    }, token);
    await mutateGroup(localId, (x) => {
      x.recordingId = st.recording_id;
      if (x.segments[0] && !x.segments[0].storagePath) x.segments[0].storagePath = st.storage_path;
    });
    fresh = { path: st.storage_path, url: st.upload_url, upsert: !!st.reused };
    g = await findGroup(localId);
    if (!g) return;
  }
  const recordingId = g.recordingId as string;

  // 2+3 · segmenten in volgorde (de volgorde bepaalt segment_paths)
  for (let i = 0; i < g.segments.length; i++) {
    const seg = g.segments[i];
    if (seg.uploaded) continue;
    let url: string;
    let upsert = false;
    let path = seg.storagePath;
    try {
      if (!path) {
        const r = i === 0
          ? await ingest('reupload', { recording_id: recordingId }, token)
          : await ingest('append', { recording_id: recordingId, ext: 'm4a', segment_no: i }, token);
        path = r.storage_path as string;
        url = r.upload_url;
        upsert = i === 0 || !!r.reused;
        const p = path;
        await mutateGroup(localId, (x) => { if (x.segments[i]) x.segments[i].storagePath = p; }); // pad bewaren VÓÓR de PUT
      } else if (fresh && fresh.path === path) {
        url = fresh.url; upsert = fresh.upsert;
      } else {
        const r = await ingest('reupload', { recording_id: recordingId, storage_path: path }, token);
        url = r.upload_url; upsert = true;
      }
    } catch (e) {
      // 409 = de server heeft deze opname al verwerkt (bv. twee keer gered) →
      // niets meer te doen, lokaal opruimen.
      if (e instanceof IngestError && e.status === 409) {
        await mutateGroup(localId, (x) => { x.completed = true; });
        const done = await findGroup(localId);
        if (done) await cleanup(done);
        return;
      }
      throw e;
    }
    fresh = null;
    await putFile(url, seg.uri, upsert, localId, i + 1);
    await mutateGroup(localId, (x) => { if (x.segments[i]) x.segments[i].uploaded = true; x.lastError = null; });
  }

  // 4 · afronden
  g = await findGroup(localId);
  if (!g || !g.finalized || g.completed || !g.segments.every((s) => s.uploaded)) return;
  const total = g.segments.reduce((sum, s) => sum + (s.duration || 0), 0);
  await ingest('complete', {
    recording_id: recordingId, ended_at: g.endedAt ?? new Date().toISOString(),
    duration_seconds: total,
    consent_status: 'informed', consent_method: 'app_notice',
    consent_details: 'Staande consent-bevestiging in de mobiele app.',
  }, token);
  await mutateGroup(localId, (x) => { x.completed = true; x.lastError = null; });
  const done = await findGroup(localId);
  if (done) await cleanup(done);
}

async function cleanup(g: QueueGroup) {
  for (const s of g.segments) await FileSystem.deleteAsync(s.uri, { idempotent: true }).catch(() => {});
  await mutate((q) => { const i = q.findIndex((x) => x.localId === g.localId); if (i >= 0) q.splice(i, 1); });
}

async function putFile(url: string, uri: string, upsert: boolean, localId: string, segment: number) {
  setState({ progress: { localId, segment, sent: 0, total: 0 } });
  const task = FileSystem.createUploadTask(url, uri, {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { 'Content-Type': 'audio/mp4', 'x-upsert': upsert ? 'true' : 'false' },
  }, (p) => setState({ progress: { localId, segment, sent: p.totalBytesSent, total: p.totalBytesExpectedToSend } }));
  const res = await task.uploadAsync();
  if (!res) throw new Error('Upload afgebroken');
  // Bestaat het object al (vorige PUT kwam wél aan, maar het antwoord niet)?
  // Dan is het bestand er — als geslaagd beschouwen.
  if (res.status === 409 || /"statusCode"\s*:\s*"409"|Duplicate/i.test(res.body ?? '')) return;
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Upload geweigerd (${res.status})${res.body ? `: ${String(res.body).slice(0, 120)}` : ''}`);
  }
}

// ── lokale melding (max. één per groep) ──────────────────────────────────────
// onlyIfFailed=true: enkel groepen die al minstens één mislukte poging hadden
// (gebruikt wanneer de app naar de achtergrond gaat).
export async function maybeNotify(localIds: string[] | null, force: boolean) {
  if (!force && AppState.currentState === 'active') return; // gebruiker ziet de kaart al
  const q = await getQueue();
  const todo = q.filter((g) => !g.notified && !g.completed && !g.missingFile
    && (localIds ? localIds.includes(g.localId) : g.attempts > 0));
  if (todo.length === 0) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'salesUp Capture',
        body: 'Opname nog niet verstuurd — open Capture om opnieuw te versturen.',
        data: { type: 'upload_retry' },
      },
      trigger: null,
    });
  } catch { /* geen meldingsrechten: best-effort */ }
  const ids = todo.map((g) => g.localId);
  await mutate((qq) => { for (const g of qq) if (ids.includes(g.localId)) g.notified = true; });
}

// ── orphan recovery: onverstuurde bestanden terugvinden ──────────────────────
export type OrphanFile = { uri: string; size: number; modifiedAt: number; estDuration: number };

// Mappen waar expo-audio opnames bewaart (iOS: <cache|document>/ExpoAudio/,
// Android: <cache|files>/Audio/) + onze eigen pending/-map.
function candidateDirs(extra: (string | null | undefined)[]): string[] {
  const c = FileSystem.cacheDirectory ?? '';
  const d = FileSystem.documentDirectory ?? '';
  const dirs = [c && `${c}ExpoAudio/`, d && `${d}ExpoAudio/`, c && `${c}Audio/`, d && `${d}Audio/`, d && PENDING_DIR];
  for (const u of extra) {
    if (u && u.includes('/')) dirs.push(u.slice(0, u.lastIndexOf('/') + 1));
  }
  return [...new Set(dirs.filter(Boolean) as string[])];
}

export async function scanOrphans(excludeUris: (string | null | undefined)[]): Promise<OrphanFile[]> {
  const q = await getQueue();
  const known = new Set<string>([
    ...q.flatMap((g) => g.segments.map((s) => s.uri)),
    ...(excludeUris.filter(Boolean) as string[]),
  ]);
  const minAgeMs = 2 * 60_000;
  const out: OrphanFile[] = [];
  for (const dir of candidateDirs(excludeUris)) {
    let names: string[] = [];
    try { names = await FileSystem.readDirectoryAsync(dir); } catch { continue; }
    for (const name of names) {
      if (!/\.(m4a|caf|aac|mp4)$/i.test(name)) continue;
      const uri = dir + name;
      if (known.has(uri)) continue;
      try {
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists || info.isDirectory) continue;
        const modifiedAt = Math.round((info.modificationTime ?? 0) * 1000);
        if (info.size < 16_000 || Date.now() - modifiedAt < minAgeMs) continue; // leeg of nog in gebruik
        // Schatting van de duur uit de bestandsgrootte: oude versies namen op in
        // HIGH_QUALITY (~128 kbps, cache), nieuwe in de spraakpreset (~64 kbps).
        const kbps = uri.startsWith(FileSystem.cacheDirectory ?? '§') ? 128 : 64;
        out.push({ uri, size: info.size, modifiedAt, estDuration: Math.round((info.size * 8) / (kbps * 1000)) });
      } catch { /* bestand onleesbaar → overslaan */ }
    }
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 50);
}
