// ============================================================================
// salesUp Capture — poll-bots
// ============================================================================
// Volgt meeting-bots op bij Recall en haalt na afloop het transcript op via
// media_shortcuts → register_transcript → bestaande pipeline (samenvatting +
// mail + brug). Polling i.p.v. webhooks. Cron: elke 5 minuten.
//
// external_ref-vormen:
//   bot:<bot_id>        ad-hoc bot (action bot_start)
//   calevent:<event_id> agenda-bot — de echte bot_id zit in het calendar-event
//                       (event.bots[].bot_id), dus die zoeken we daar op.
//
// Transiënte fouten (bot nog niet aangemaakt, netwerk) blijven 'pending_upload'
// en worden bij de volgende run opnieuw geprobeerd; pas na MAX_AGE_H → 'error'.
//
// Secrets: RECALL_API_KEY (+ RECALL_API_URL, default eu-central-1)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MAX_AGE_H = 24 // bots ouder dan 24u zonder transcript → error

interface Segment { speaker: string | null; start_s: number | null; end_s: number | null; text: string }

function numOrNull(v: any): number | null {
  const n = Number(v)
  return isFinite(n) ? n : null
}

// Recall transcript-download: [{participant:{name}, words:[{text,start_timestamp:{relative},end_timestamp:{relative}}]}]
function toSegments(data: any): Segment[] {
  if (!Array.isArray(data)) return []
  const out: Segment[] = []
  for (const block of data) {
    const words = Array.isArray(block?.words) ? block.words : []
    if (words.length === 0) continue
    const text = words.map((w: any) => String(w?.text ?? '')).join(' ').replace(/\s+/g, ' ').trim()
    if (!text) continue
    out.push({
      speaker: block?.participant?.name ?? null,
      start_s: numOrNull(words[0]?.start_timestamp?.relative),
      end_s:   numOrNull(words[words.length - 1]?.end_timestamp?.relative),
      text,
    })
  }
  return out
}

function findTranscriptUrl(bot: any): string | null {
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

  let q = sb.from('recordings')
    .select('id, external_ref, started_at, created_at')
    .or('external_ref.like.bot:%,external_ref.like.calevent:%')
    .eq('status', 'pending_upload')
    .order('created_at', { ascending: true })
    .limit(limit)
  if (body?.recording_id) q = q.eq('id', body.recording_id)
  const { data: todo } = await q

  const tooOld = (rec: any) => Date.now() - new Date(rec.created_at).getTime() > MAX_AGE_H * 3600_000

  let done = 0, waiting = 0, failed = 0
  for (const rec of todo ?? []) {
    try {
      const botId = await resolveBotId(String(rec.external_ref))
      if (!botId) {
        // bot nog niet geïnstantieerd door Recall — later opnieuw proberen
        if (tooOld(rec)) {
          await sb.from('recordings').update({ status: 'error', error: 'geen bot gevonden voor dit event binnen 24u' }).eq('id', rec.id)
          failed++
        } else { waiting++ }
        continue
      }
      const res = await fetch(`${recallUrl}/api/v1/bot/${botId}/`, { headers })
      if (!res.ok) throw new Error(`Recall ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const bot = await res.json()

      const url = findTranscriptUrl(bot)
      if (url) {
        const tRes = await fetch(url)
        if (!tRes.ok) throw new Error(`transcript download ${tRes.status}`)
        const segments = toSegments(await tRes.json())
        if (segments.length === 0) throw new Error('leeg transcript van de bot (niemand gesproken?)')

        const durationS = Math.max(...segments.map((s) => s.end_s ?? 0))
        await sb.from('recordings').update({
          ended_at: new Date().toISOString(),
          duration_seconds: durationS > 0 ? Math.round(durationS) : null,
        }).eq('id', rec.id)

        const { error: rpcErr } = await sb.rpc('register_transcript', {
          p_recording_id: rec.id,
          p_full_text: segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n'),
          p_segments: segments,
          p_language: null,
          p_provider: 'recall_bot',
        })
        if (rpcErr) throw new Error(rpcErr.message)
        done++
      } else if (botFailed(bot)) {
        const changes = bot?.status_changes ?? []
        const last = changes.length ? changes[changes.length - 1] : {}
        await sb.from('recordings').update({
          status: 'error',
          error: `bot mislukt: ${last?.code ?? 'onbekend'}${last?.sub_code ? ` (${last.sub_code})` : ''}`,
        }).eq('id', rec.id)
        failed++
      } else if (tooOld(rec)) {
        await sb.from('recordings').update({
          status: 'error',
          error: `bot leverde binnen ${MAX_AGE_H}u geen transcript — opgegeven`,
        }).eq('id', rec.id)
        failed++
      } else {
        waiting++
      }
    } catch (e) {
      // transiënt: niet definitief op 'error' zetten — volgende run probeert opnieuw,
      // tenzij de opname al te oud is. Fout wel loggen in de error-kolom.
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
