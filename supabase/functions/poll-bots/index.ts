// ============================================================================
// salesUp Capture — poll-bots
// ============================================================================
// Volgt lopende meeting-bots (external_ref 'bot:<id>') op bij Recall en haalt
// na afloop het transcript op via media_shortcuts → register_transcript →
// bestaande pipeline (samenvatting + mail + brug). Polling i.p.v. webhooks:
// geen dashboard-configuratie nodig. Cron: elke 5 minuten.
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

  let q = sb.from('recordings')
    .select('id, external_ref, started_at, created_at')
    .like('external_ref', 'bot:%')
    .eq('status', 'pending_upload')
    .order('created_at', { ascending: true })
    .limit(limit)
  if (body?.recording_id) q = q.eq('id', body.recording_id)
  const { data: todo } = await q

  let done = 0, waiting = 0, failed = 0
  for (const rec of todo ?? []) {
    try {
      const botId = String(rec.external_ref).slice(4)
      const res = await fetch(`${recallUrl}/api/v1/bot/${botId}/`, {
        headers: { Authorization: `Token ${recallKey}` },
      })
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
      } else if (Date.now() - new Date(rec.created_at).getTime() > MAX_AGE_H * 3600_000) {
        await sb.from('recordings').update({
          status: 'error',
          error: `bot leverde binnen ${MAX_AGE_H}u geen transcript — opgegeven`,
        }).eq('id', rec.id)
        failed++
      } else {
        waiting++
      }
    } catch (e) {
      failed++
      await sb.from('recordings')
        .update({ status: 'error', error: String(e).slice(0, 500) })
        .eq('id', rec.id)
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
