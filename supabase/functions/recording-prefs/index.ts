// ============================================================================
// salesUp Capture — recording-prefs
// ============================================================================
// Laat een ingelogde gebruiker zijn EIGEN opname markeren:
//   - marked_internal: true/false  (interne meeting?)
//   - share_to_training: true/false (doorsturen naar trainingsplatform?)
// Schrijven loopt via service-role na een ownership-check, zodat een gebruiker
// nooit andere velden of andermans opnames kan wijzigen.
//
// POST { recording_id, marked_internal?, share_to_training? }  (Bearer user-JWT)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const { data: au } = await sb.auth.getUser(jwt)
  if (!au?.user?.id) return json({ ok: false, error: 'unauthorized' }, 401)

  let body: any = {}
  try { body = await req.json() } catch { return json({ ok: false, error: 'JSON-body vereist' }, 400) }
  if (!body.recording_id) return json({ ok: false, error: 'recording_id verplicht' }, 400)

  // Eigenaarscheck: de opname moet bij een actief lidmaatschap van deze gebruiker horen.
  const { data: rec } = await sb.from('recordings')
    .select('id, member_id, bridged_at, members!inner(user_id, is_active)')
    .eq('id', body.recording_id).maybeSingle()
  const owner = (rec as any)?.members
  if (!rec || !owner || owner.user_id !== au.user.id || owner.is_active !== true) {
    return json({ ok: false, error: 'opname niet gevonden of geen toegang' }, 403)
  }

  const patch: Record<string, unknown> = {}
  if (typeof body.marked_internal === 'boolean') {
    patch.marked_internal = body.marked_internal
    // Interne meeting → standaard niet doorsturen (tenzij expliciet anders meegegeven).
    if (body.marked_internal === true && body.share_to_training === undefined) patch.share_to_training = false
  }
  if (typeof body.share_to_training === 'boolean') patch.share_to_training = body.share_to_training
  if (Object.keys(patch).length === 0) return json({ ok: false, error: 'niets te wijzigen' }, 400)

  const { error } = await sb.from('recordings').update(patch).eq('id', body.recording_id)
  if (error) return json({ ok: false, error: error.message }, 500)

  return json({ ok: true, recording_id: body.recording_id, ...patch })
})

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...CORS },
  })
}
