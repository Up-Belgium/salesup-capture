// ============================================================================
// salesUp Capture — transcribe-recordings (standalone project)
// ============================================================================
// Transcribeert geüploade opnames via Deepgram (NL + diarization) en
// registreert via register_transcript. Draait elke 10 minuten (cron) zodat de
// samenvattingsmail kort na de meeting vertrekt.
//
// Modi:  POST {} (batch, default 10, max 25) | { recording_id } | { limit }
// Secrets: DEEPGRAM_API_KEY
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BUCKET = 'recordings'
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&diarize=true&detect_language=true'

interface Segment { speaker: string | null; start_s: number | null; end_s: number | null; text: string }

function extractSegments(dg: any): Segment[] {
  const words = dg?.results?.channels?.[0]?.alternatives?.[0]?.words
  if (!Array.isArray(words) || words.length === 0) return []
  const out: Segment[] = []
  let cur: Segment | null = null
  for (const w of words) {
    const speaker = w?.speaker != null ? `Spreker ${w.speaker}` : null
    const word = String(w?.punctuated_word ?? w?.word ?? '').trim()
    if (!word) continue
    if (cur && cur.speaker === speaker) {
      cur.text += ` ${word}`
      cur.end_s = numOrNull(w?.end) ?? cur.end_s
    } else {
      if (cur) out.push(cur)
      cur = { speaker, start_s: numOrNull(w?.start), end_s: numOrNull(w?.end), text: word }
    }
  }
  if (cur) out.push(cur)
  return out
}

function numOrNull(v: any): number | null {
  const n = Number(v)
  return isFinite(n) ? n : null
}

Deno.serve(async (req) => {
  const dgKey = (Deno.env.get('DEEPGRAM_API_KEY') ?? '').trim()
  if (!dgKey) return json({ ok: false, error: 'DEEPGRAM_API_KEY niet gezet als Edge Function secret' }, 500)

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let body: any = {}
  try { body = await req.json() } catch { /* batch */ }
  const limit = Math.min(Number(body?.limit) || 10, 25)

  let todo: any[] = []
  if (body?.recording_id) {
    const { data } = await sb.from('v_pending_transcription').select('*').eq('id', body.recording_id).limit(1)
    todo = data ?? []
  } else {
    const { data } = await sb.from('v_pending_transcription')
      .select('*').order('started_at', { ascending: true }).limit(limit)
    todo = data ?? []
  }

  let transcribed = 0, failed = 0
  for (const rec of todo) {
    try {
      await sb.from('recordings').update({ status: 'transcribing' }).eq('id', rec.id)
      const { data: blob, error: dlErr } = await sb.storage.from(BUCKET).download(rec.storage_path)
      if (dlErr || !blob) throw new Error(`storage download: ${dlErr?.message ?? 'leeg bestand'}`)

      const res = await fetch(DEEPGRAM_URL, {
        method: 'POST',
        headers: { Authorization: `Token ${dgKey}`, 'Content-Type': blob.type || 'audio/mp4' },
        body: blob,
      })
      if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const dg = await res.json()

      const alt = dg?.results?.channels?.[0]?.alternatives?.[0]
      const fullText: string = String(alt?.transcript ?? '').trim()
      if (!fullText) throw new Error('Deepgram gaf een leeg transcript (stilte of onleesbare audio?)')
      const segments = extractSegments(dg)
      const language = dg?.results?.channels?.[0]?.detected_language ?? rec.language ?? null

      const { error: rpcErr } = await sb.rpc('register_transcript', {
        p_recording_id: rec.id,
        p_full_text: segments.length > 0
          ? segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n')
          : fullText,
        p_segments: segments.length > 0 ? segments : null,
        p_language: language,
        p_provider: 'deepgram',
      })
      if (rpcErr) throw new Error(rpcErr.message)
      transcribed++
    } catch (e) {
      failed++
      await sb.from('recordings')
        .update({ status: 'error', error: String(e).slice(0, 500) })
        .eq('id', rec.id)
    }
  }

  console.log(`transcribe-recordings: todo=${todo.length} ok=${transcribed} failed=${failed}`)
  return json({ ok: true, processed: todo.length, transcribed, failed })
})

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
