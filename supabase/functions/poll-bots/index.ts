// ============================================================================
// salesUp Capture — poll-bots
// ============================================================================
// Volgt meeting-bots op bij Recall en zorgt voor het transcript → register_
// transcript → bestaande pipeline (samenvatting + mail + brug). Polling i.p.v.
// webhooks. Cron: elke 5 minuten.
//
// TRANSCRIPTIE = ASYNC (recallai_async), niet streaming.
//   Recall's real-time streaming-ASR (recallai_streaming/language_code:auto)
//   leverde onbruikbare transcripties op: woord-per-woord versplintering met
//   pingpongende sprekers, plus vreemde-taal-hallucinaties (Spaans/Portugees/…)
//   op Nederlandse/Engelse audio. Async batch-transcriptie beslist één keer per
//   opname over de taal en gebruikt aparte deelnemersstreams voor de diarisatie,
//   wat beide problemen wegneemt. Zie create_transcript hieronder.
//
// Flow per opname:
//   1. Bot afgelopen + opname verwerkt (streaming-transcript aanwezig = signaal
//      dat de media klaar is) → POST create_transcript(recallai_async) →
//      job-id bewaren in recordings.recall_async_transcript_id.
//   2. Volgende run: GET /transcript/{id} → status 'done' → download + register
//      (provider recallai_async). Bij 'failed' → terugvallen op het streaming-
//      transcript zodat er nooit een meeting zonder transcript blijft.
//
// external_ref-vormen:
//   bot:<bot_id>        ad-hoc bot (action bot_start)
//   calevent:<event_id> agenda-bot — de echte bot_id zit in het calendar-event.
//
// Handmatig (test/backfill): POST { retranscribe_recording_id:<uuid> } vraagt
// async transcriptie aan (of voltooit ze) voor één opname, ongeacht status.
//
// Transiënte fouten blijven 'pending_upload' en worden opnieuw geprobeerd; pas
// na MAX_AGE_H → 'error'.
//
// Secrets: RECALL_API_KEY (+ RECALL_API_URL, default eu-central-1)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// cron-guard: zie transcribe-recordings. FAIL-OPEN tot CRON_SECRET gezet is.
function cronForbidden(req: Request): Response | null {
  const expected = (Deno.env.get('CRON_SECRET') ?? '').trim()
  if (!expected) return null
  const got = (req.headers.get('x-cron-secret') ?? '').trim()
  if (got === expected) return null
  return new Response(JSON.stringify({ error: 'forbidden (cron-secret)' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
}

const MAX_AGE_H = 24 // bots ouder dan 24u zonder transcript → error

interface Segment { speaker: string | null; start_s: number | null; end_s: number | null; text: string }

function numOrNull(v: any): number | null {
  const n = Number(v)
  return isFinite(n) ? n : null
}

// Recall transcript-download (streaming én async):
//   [{participant:{name}, language_code?, words:[{text,start_timestamp:{relative},end_timestamp:{relative}}]}]
// We voegen opeenvolgende blokken van DEZELFDE spreker samen tot één spreekbeurt
// (async met aparte streams levert meestal al nette beurten, maar dit blijft een
// goedkope opkuis). Een blok van een andere spreker breekt de beurt af.
function toSegments(data: any): Segment[] {
  if (!Array.isArray(data)) return []
  const raw: Segment[] = []
  for (const block of data) {
    const words = Array.isArray(block?.words) ? block.words : []
    if (words.length === 0) continue
    const text = words.map((w: any) => String(w?.text ?? '')).join(' ').replace(/\s+/g, ' ').trim()
    if (!text) continue
    raw.push({
      speaker: block?.participant?.name ?? null,
      start_s: numOrNull(words[0]?.start_timestamp?.relative),
      end_s:   numOrNull(words[words.length - 1]?.end_timestamp?.relative),
      text,
    })
  }
  const merged: Segment[] = []
  for (const seg of raw) {
    const prev = merged[merged.length - 1]
    if (prev && prev.speaker === seg.speaker) {
      prev.text = `${prev.text} ${seg.text}`.replace(/\s+/g, ' ').trim()
      prev.end_s = seg.end_s ?? prev.end_s
    } else {
      merged.push({ ...seg })
    }
  }
  return merged
}

// Meest voorkomende taalcode uit de ruwe blokken (async levert language_code
// per spreker/beurt). null als niets bruikbaar.
function dominantLanguage(data: any): string | null {
  if (!Array.isArray(data)) return null
  const counts = new Map<string, number>()
  for (const block of data) {
    const lc = block?.language_code
    if (typeof lc === 'string' && lc && lc !== 'auto') counts.set(lc, (counts.get(lc) ?? 0) + 1)
  }
  let best: string | null = null, bestN = 0
  for (const [lc, n] of counts) if (n > bestN) { best = lc; bestN = n }
  return best
}

function firstRecordingId(bot: any): string | null {
  const recs = Array.isArray(bot?.recordings) ? bot.recordings : []
  for (const r of recs) if (typeof r?.id === 'string' && r.id) return r.id
  return null
}

function findStreamingTranscriptUrl(bot: any): string | null {
  const recs = Array.isArray(bot?.recordings) ? bot.recordings : []
  for (const r of recs) {
    const url = r?.media_shortcuts?.transcript?.data?.download_url
    if (typeof url === 'string' && url.startsWith('http')) return url
  }
  return null
}

function botFailed(bot: any): boolean {
  const changes = Array.isArray(bot?.status_changes) ? bot.status_changes : []
  const last = changes.length ? String(changes[changes.length - 1]?.code ?? '') : ''
  return ['fatal', 'analysis_failed', 'recording_permission_denied'].includes(last)
}

Deno.serve(async (req) => {
  const denied = cronForbidden(req); if (denied) return denied
  const recallKey = (Deno.env.get('RECALL_API_KEY') ?? '').trim()
  if (!recallKey) return json({ ok: false, error: 'RECALL_API_KEY niet gezet als Edge Function secret' }, 500)
  const recallUrl = (Deno.env.get('RECALL_API_URL') ?? 'https://eu-central-1.recall.ai').trim()

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let body: any = {}
  try { body = await req.json() } catch { /* batch */ }
  const limit = Math.min(Number(body?.limit) || 20, 50)

  const headers = { Authorization: `Token ${recallKey}` }
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' }

  // De echte bot_id ophalen: direct (bot:) of via het calendar-event (calevent:)
  async function resolveBotId(externalRef: string): Promise<string | null> {
    if (externalRef.startsWith('bot:')) return externalRef.slice(4)
    if (externalRef.startsWith('calevent:')) {
      const eventId = externalRef.slice(9)
      const r = await fetch(`${recallUrl}/api/v2/calendar-events/${eventId}/`, { headers })
      if (!r.ok) return null
      const ev = await r.json()
      const bots = Array.isArray(ev?.bots) ? ev.bots : []
      const match = bots.find((b: any) => b?.deduplication_key === `salesup-${eventId}`) ?? bots[bots.length - 1]
      return match?.bot_id ?? match?.id ?? null
    }
    return null
  }

  // Async transcriptie aanvragen op een Recall-recording. Geeft het job-id terug.
  async function createAsyncTranscript(recordingId: string): Promise<string> {
    const r = await fetch(`${recallUrl}/api/v1/recording/${recordingId}/create_transcript/`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        provider: { recallai_async: { language_code: 'auto' } },
        diarization: { use_separate_streams_when_available: true },
      }),
    })
    if (!r.ok) throw new Error(`create_transcript ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json()
    const id = j?.id
    if (typeof id !== 'string' || !id) throw new Error('create_transcript gaf geen transcript-id terug')
    return id
  }

  // Status + download-url van een async transcript-job ophalen.
  async function getTranscript(transcriptId: string): Promise<{ status: string; url: string | null }> {
    const r = await fetch(`${recallUrl}/api/v1/transcript/${transcriptId}/`, { headers })
    if (!r.ok) throw new Error(`transcript ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json()
    const status = String(j?.status?.code ?? j?.status ?? 'processing')
    const url = j?.data?.download_url ?? null
    return { status, url: typeof url === 'string' && url.startsWith('http') ? url : null }
  }

  // Een transcript-download registreren + opname bijwerken.
  async function register(recId: string, downloadUrl: string, provider: string) {
    const tRes = await fetch(downloadUrl)
    if (!tRes.ok) throw new Error(`transcript download ${tRes.status}`)
    const raw = await tRes.json()
    const segments = toSegments(raw)
    if (segments.length === 0) throw new Error('leeg transcript (niemand gesproken?)')
    const durationS = Math.max(...segments.map((s) => s.end_s ?? 0))
    await sb.from('recordings').update({
      ended_at: new Date().toISOString(),
      duration_seconds: durationS > 0 ? Math.round(durationS) : null,
    }).eq('id', recId)
    const { error: rpcErr } = await sb.rpc('register_transcript', {
      p_recording_id: recId,
      p_full_text: segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n'),
      p_segments: segments,
      p_language: dominantLanguage(raw),
      p_provider: provider,
    })
    if (rpcErr) throw new Error(rpcErr.message)
  }

  // "Te oud" meten vanaf de MEETING (started_at), fallback op created_at.
  const refMs = (rec: any) => new Date(rec.started_at ?? rec.created_at).getTime()
  const tooOld = (rec: any) => Date.now() - refMs(rec) > MAX_AGE_H * 3600_000

  // Verwerk één opname. Geeft 'done' | 'waiting' | 'failed' terug.
  async function processOne(rec: any): Promise<'done' | 'waiting' | 'failed'> {
    const botId = await resolveBotId(String(rec.external_ref))
    if (!botId) {
      if (tooOld(rec)) {
        await sb.from('recordings').update({ status: 'error', error: 'geen bot gevonden voor dit event binnen 24u' }).eq('id', rec.id)
        return 'failed'
      }
      return 'waiting'
    }
    const res = await fetch(`${recallUrl}/api/v1/bot/${botId}/`, { headers })
    if (!res.ok) throw new Error(`Recall ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const bot = await res.json()

    // ── Fase 2: async job loopt al → status pollen ────────────────────────
    if (rec.recall_async_transcript_id) {
      const { status, url } = await getTranscript(rec.recall_async_transcript_id)
      if (status === 'done' && url) {
        await register(rec.id, url, 'recallai_async')
        return 'done'
      }
      if (status === 'failed' || status === 'error' || status === 'deleted') {
        // Terugvallen op het streaming-transcript zodat er iets bruikbaars is.
        const streamUrl = findStreamingTranscriptUrl(bot)
        if (streamUrl) {
          await register(rec.id, streamUrl, 'recall_bot')
          console.log(`poll-bots: async ${status} voor ${rec.id} → streaming-fallback gebruikt`)
          return 'done'
        }
        await sb.from('recordings').update({ status: 'error', error: `async transcriptie ${status} en geen streaming-fallback` }).eq('id', rec.id)
        return 'failed'
      }
      // processing
      if (tooOld(rec)) {
        await sb.from('recordings').update({ status: 'error', error: `async transcriptie niet klaar binnen ${MAX_AGE_H}u` }).eq('id', rec.id)
        return 'failed'
      }
      return 'waiting'
    }

    // ── Fase 1: nog geen async job → aanvragen zodra de opname verwerkt is ─
    // Signaal dat de media klaar is: het streaming-transcript is beschikbaar.
    const recordingId = firstRecordingId(bot)
    const mediaReady = !!findStreamingTranscriptUrl(bot)
    if (recordingId && mediaReady) {
      const transcriptId = await createAsyncTranscript(recordingId)
      await sb.from('recordings').update({ recall_async_transcript_id: transcriptId, error: null }).eq('id', rec.id)
      return 'waiting' // volgende run haalt het resultaat op
    }
    if (botFailed(bot)) {
      const changes = bot?.status_changes ?? []
      const last = changes.length ? changes[changes.length - 1] : {}
      await sb.from('recordings').update({
        status: 'error',
        error: `bot mislukt: ${last?.code ?? 'onbekend'}${last?.sub_code ? ` (${last.sub_code})` : ''}`,
      }).eq('id', rec.id)
      return 'failed'
    }
    if (tooOld(rec)) {
      await sb.from('recordings').update({ status: 'error', error: `bot leverde binnen ${MAX_AGE_H}u geen opname — opgegeven` }).eq('id', rec.id)
      return 'failed'
    }
    return 'waiting'
  }

  // ── Selectie: normaal (pending_upload) of handmatig één opname ──────────
  let q = sb.from('recordings')
    .select('id, external_ref, started_at, created_at, recall_async_transcript_id')
    .or('external_ref.like.bot:%,external_ref.like.calevent:%')
    .order('created_at', { ascending: true })
    .limit(limit)
  if (body?.retranscribe_recording_id) {
    q = q.eq('id', body.retranscribe_recording_id) // ongeacht status (backfill/test)
  } else if (body?.recording_id) {
    q = q.eq('id', body.recording_id).eq('status', 'pending_upload')
  } else {
    q = q.eq('status', 'pending_upload')
  }
  const { data: todo } = await q

  let done = 0, waiting = 0, failed = 0
  for (const rec of todo ?? []) {
    try {
      const r = await processOne(rec)
      if (r === 'done') done++; else if (r === 'failed') failed++; else waiting++
    } catch (e) {
      await sb.from('recordings')
        .update(tooOld(rec) ? { status: 'error', error: String(e).slice(0, 500) } : { error: String(e).slice(0, 500) })
        .eq('id', rec.id)
      waiting++
    }
  }

  console.log(`poll-bots: todo=${(todo ?? []).length} done=${done} waiting=${waiting} failed=${failed}`)
  return json({ ok: true, processed: (todo ?? []).length, done, waiting, failed })
})

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
