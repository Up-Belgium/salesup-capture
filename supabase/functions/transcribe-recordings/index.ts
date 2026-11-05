// ============================================================================
// salesUp Capture — transcribe-recordings (standalone project)
// ============================================================================
// Transcribeert geüploade opnames via Deepgram (NL + diarization) en
// registreert via register_transcript. Draait elke 10 minuten (cron) zodat de
// samenvattingsmail kort na de meeting vertrekt.
//
// Modi:  POST {} (batch, default 10, max 25) | { recording_id } | { limit }
// Secrets: DEEPGRAM_API_KEY (+ optioneel TRAINING_URL/TRAINING_SERVICE_ROLE_KEY voor de woordenlijst)
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
// EU-endpoint (verwerking binnen de EU, geen fallback) + mip_opt_out=true (geen
// bewaring bij Deepgram voor modelverbetering). GDPR — subverwerkersoverzicht okt 2026.
const DEEPGRAM_URL = 'https://api.eu.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&language=multi&mip_opt_out=true'

// Woordenlijst van de trainingsklant (pagina Kwaliteitsregels, module sales of beide) als
// Deepgram-keyterms (nov 2026): namen, merken, producten, acties en concurrenten worden beter
// herkend. Zelfde regels als transcribe-genesys in het trainingsproject: verboden formuleringen
// NIET (een geboost woord kan opduiken waar het niet gezegd werd), max 50 termen en ~1500 tekens.
// Leest het trainingsproject met dezelfde secrets als bridge-to-training; zonder secrets of bij een
// fout transcriberen we gewoon zonder woordenlijst.
const KEYTERM_MAX = 50
const KEYTERM_CHARS = 1500

function deepgramUrl(keyterms: string[]): string {
  return DEEPGRAM_URL + keyterms.map((t) => `&keyterm=${encodeURIComponent(t)}`).join('')
}

// org_id (Capture) → keyterms van de gekoppelde trainingsklant (organizations.training_client_id).
async function loadKeytermsByOrg(sb: any, orgIds: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  const trainingUrl = (Deno.env.get('TRAINING_URL') ?? '').trim()
  const trainingKey = (Deno.env.get('TRAINING_SERVICE_ROLE_KEY') ?? '').trim()
  if (!trainingUrl || !trainingKey || orgIds.length === 0) return out
  try {
    const { data: orgs } = await sb.from('organizations').select('id, training_client_id').in('id', orgIds)
    const clientByOrg: Record<string, string> = {}
    for (const o of orgs ?? []) if (o.training_client_id) clientByOrg[o.id] = o.training_client_id
    const clientIds = [...new Set(Object.values(clientByOrg))]
    if (clientIds.length === 0) return out
    const training = createClient(trainingUrl, trainingKey)
    const { data, error } = await training.from('training_quality_lexicon')
      .select('client_id, term, term_type').in('client_id', clientIds)
      .or('module.eq.sales,module.is.null').neq('term_type', 'verboden').order('term').limit(500)
    if (error) { console.error('woordenlijst', error.message); return out }
    const byClient: Record<string, string[]> = {}
    const seen: Record<string, Set<string>> = {}
    const used: Record<string, number> = {}
    for (const r of data ?? []) {
      const term = String(r.term ?? '').trim().slice(0, 100)
      if (!term) continue
      const set = (seen[r.client_id] ??= new Set())
      const list = (byClient[r.client_id] ??= [])
      if (set.has(term.toLowerCase()) || list.length >= KEYTERM_MAX || (used[r.client_id] ?? 0) + term.length > KEYTERM_CHARS) continue
      set.add(term.toLowerCase()); list.push(term); used[r.client_id] = (used[r.client_id] ?? 0) + term.length
    }
    for (const [orgId, clientId] of Object.entries(clientByOrg)) if (byClient[clientId]?.length) out[orgId] = byClient[clientId]
  } catch (e) {
    console.error('woordenlijst', String(e).slice(0, 200))
  }
  return out
}

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

  const keytermsByOrg = await loadKeytermsByOrg(sb, [...new Set(todo.map((r: any) => r.org_id).filter(Boolean))] as string[])

  let transcribed = 0, failed = 0
  for (const rec of todo) {
    const keyterms = keytermsByOrg[rec.org_id] ?? []
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

        const post = (terms: string[]) => fetch(deepgramUrl(terms), {
          method: 'POST',
          headers: { Authorization: `Token ${dgKey}`, 'Content-Type': blob.type || 'audio/mp4' },
          body: blob,
        })
        let res = await post(keyterms)
        // Weigert Deepgram de keyterms (bv. niet ondersteund voor deze taal/model), dan zonder opnieuw.
        if (!res.ok && res.status === 400 && keyterms.length) {
          console.error('Deepgram weigerde keyterms:', (await res.text()).slice(0, 200))
          res = await post([])
        }
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

  console.log(`transcribe-recordings: todo=${todo.length} ok=${transcribed} failed=${failed} woordenlijst_orgs=${Object.keys(keytermsByOrg).length}`)
  return json({ ok: true, processed: todo.length, transcribed, failed })
})

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
