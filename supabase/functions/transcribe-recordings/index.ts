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
// cron-guard: deze functie wordt door pg_cron getriggerd met de publieke anon-key
// (zit ook in de mobiele app). Extra gedeeld geheim: cron stuurt header
// x-cron-secret (uit Vault), functie vergelijkt met env CRON_SECRET. FAIL-OPEN:
// zolang CRON_SECRET niet gezet is, laat de guard alles door (breekt niets).
function cronForbidden(req: Request): Response | null {
  const expected = (Deno.env.get('CRON_SECRET') ?? '').trim()
  if (!expected) return null
  const got = (req.headers.get('x-cron-secret') ?? '').trim()
  if (got === expected) return null
  return new Response(JSON.stringify({ error: 'forbidden (cron-secret)' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
}

const BUCKET = 'recordings'
// nova-3 + language=multi: NL/FR/EN code-switching, met smart_format + diarize
// voor leesbare, per-spreker segmenten (gelijk aan de live-config).
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&language=multi'

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
  const denied = cronForbidden(req); if (denied) return denied
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

      // Alle audiosegmenten in volgorde: storage_path = segment 1, daarna de
      // extra segment_paths (na onderbrekingen). We transcriberen elk segment en
      // plakken tekst + spreker-segmenten aan elkaar, met een tijd-offset per
      // segment, zodat één opname ook één transcript/verslag oplevert.
      const { data: recRow } = await sb.from('recordings').select('segment_paths').eq('id', rec.id).maybeSingle()
      const extra: string[] = Array.isArray(recRow?.segment_paths) ? recRow.segment_paths : []
      const paths = [rec.storage_path, ...extra].filter(Boolean)

      const allSegments: Segment[] = []
      const texts: string[] = []
      let language: string | null = rec.language ?? null
      let offset = 0

      for (const path of paths) {
        const { data: blob, error: dlErr } = await sb.storage.from(BUCKET).download(path)
        if (dlErr || !blob) throw new Error(`storage download (${path}): ${dlErr?.message ?? 'leeg bestand'}`)

        const res = await fetch(DEEPGRAM_URL, {
          method: 'POST',
          headers: { Authorization: `Token ${dgKey}`, 'Content-Type': blob.type || 'audio/mp4' },
          body: blob,
        })
        if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`)
        const dg = await res.json()

        const alt = dg?.results?.channels?.[0]?.alternatives?.[0]
        const segs = extractSegments(dg)
        const partText = segs.length > 0
          ? segs.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n')
          : String(alt?.transcript ?? '').trim()
        if (partText) texts.push(partText)
        for (const s of segs) {
          allSegments.push({
            ...s,
            start_s: s.start_s != null ? s.start_s + offset : null,
            end_s: s.end_s != null ? s.end_s + offset : null,
          })
        }
        if (language == null) language = dg?.results?.channels?.[0]?.detected_language ?? null
        const dur = numOrNull(dg?.metadata?.duration) ?? (segs.length ? (segs[segs.length - 1].end_s ?? 0) : 0)
        offset += dur ?? 0
      }

      const fullText = texts.join('\n').trim()
      if (!fullText) throw new Error('Deepgram gaf een leeg transcript (stilte of onleesbare audio?)')

      const { error: rpcErr } = await sb.rpc('register_transcript', {
        p_recording_id: rec.id,
        p_full_text: fullText,
        p_segments: allSegments.length > 0 ? allSegments : null,
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
