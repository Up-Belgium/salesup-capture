// ============================================================================
// salesUp Capture — bridge-to-training
// ============================================================================
// Zet getranscribeerde opnames door naar het trainingsplatform (apart Supabase-
// project): rij in training_leexi_calls (provider 'salesup_capture') + tekst in
// training_call_transcripts. Daarna doet de bestaande nachtelijke pipeline
// (evaluate-calls, analyze-competencies) daar de kwaliteitsanalyse.
//
// Alleen opnames van organisaties/leden met een training-mapping
// (organizations.training_client_id + members.training_participant_id) gaan mee
// — zie v_pending_bridge.
//
// Secrets: TRAINING_URL                (https://<training-ref>.supabase.co)
//          TRAINING_SERVICE_ROLE_KEY   (service-key van het trainingsproject)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const trainingUrl = (Deno.env.get('TRAINING_URL') ?? '').trim()
  const trainingKey = (Deno.env.get('TRAINING_SERVICE_ROLE_KEY') ?? '').trim()
  if (!trainingUrl || !trainingKey) {
    // Brug is optioneel: zonder secrets netjes overslaan (geen 500-spam in de cron).
    return json({ ok: true, skipped: 'training-bridge niet geconfigureerd (TRAINING_URL/TRAINING_SERVICE_ROLE_KEY ontbreken)' }, 200)
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const training = createClient(trainingUrl, trainingKey)

  let body: any = {}
  try { body = await req.json() } catch { /* batch */ }
  const limit = Math.min(Number(body?.limit) || 20, 50)

  const { data: todo } = await sb.from('v_pending_bridge')
    .select('*').order('started_at', { ascending: true }).limit(limit)

  let bridged = 0, failed = 0
  for (const rec of todo ?? []) {
    const ext = 'cap_' + String(rec.id).replace(/-/g, '')
    try {
      const { data: existing } = await training.from('training_leexi_calls')
        .select('id').eq('external_id', ext).maybeSingle()
      if (!existing) {
        const { error: insErr } = await training.from('training_leexi_calls').insert({
          participant_id:   rec.training_participant_id,
          client_id:        rec.training_client_id,
          external_id:      ext,
          call_date:        rec.started_at,
          duration_seconds: rec.duration_seconds,
          provider:         'salesup_capture',
          language:         rec.language,
        })
        if (insErr) throw new Error(insErr.message)
      }
      const { error: trErr } = await training.from('training_call_transcripts').upsert({
        call_external_id: ext,
        client_id:        rec.training_client_id,
        participant_id:   rec.training_participant_id,
        provider:         'salesup_capture',
        language:         rec.language,
        full_text:        rec.full_text,
        segments:         rec.segments,
        word_count:       rec.word_count,
        fetched_at:       new Date().toISOString(),
        fetch_error:      null,
        updated_at:       new Date().toISOString(),
      }, { onConflict: 'call_external_id' })
      if (trErr) throw new Error(trErr.message)

      await sb.from('recordings').update({
        bridged_at: new Date().toISOString(), bridge_error: null,
      }).eq('id', rec.id)
      bridged++
    } catch (e) {
      failed++
      await sb.from('recordings').update({ bridge_error: String(e).slice(0, 500) }).eq('id', rec.id)
    }
  }

  console.log(`bridge-to-training: todo=${(todo ?? []).length} bridged=${bridged} failed=${failed}`)
  return json({ ok: true, processed: (todo ?? []).length, bridged, failed })
})

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
