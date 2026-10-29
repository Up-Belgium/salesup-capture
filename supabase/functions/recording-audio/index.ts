// ============================================================================
// salesUp Capture — recording-audio
// ============================================================================
// Geeft een ingelogde gebruiker een tijdelijke afspeellink (1 uur) voor de audio
// van zijn EIGEN opname, voor de speler in het webportaal. Zelfde eigenaarscheck
// als recording-prefs; de bucket blijft privé.
//
// POST { recording_id }  (Bearer user-JWT)  →  { ok, url | null }
// url is null als de opname geen audiobestand in storage heeft (bv. een
// bot-opname die enkel een transcript opleverde).
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BUCKET = 'recordings'
const TTL_SECONDS = 3600
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

  const { data: rec } = await sb.from('recordings')
    .select('id, storage_path, status, members!inner(user_id, is_active)')
    .eq('id', body.recording_id).maybeSingle()
  const owner = (rec as any)?.members
  if (!rec || !owner || owner.user_id !== au.user.id || owner.is_active !== true) {
    return json({ ok: false, error: 'opname niet gevonden of geen toegang' }, 403)
  }
  if (!rec.storage_path || rec.status === 'purged') return json({ ok: true, url: null })

  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(rec.storage_path, TTL_SECONDS)
  if (error) return json({ ok: true, url: null })
  return json({ ok: true, url: data.signedUrl })
})

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...CORS },
  })
}
