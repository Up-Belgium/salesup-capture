// ============================================================================
// salesUp Capture — ingest-recording (standalone project)
// ============================================================================
// Eén ingest-punt voor alle capture-clients. Drie auth-paden:
//   1. Gebruikers-JWT (mobiele/desktop-app): Authorization: Bearer <jwt>
//      → scope = de organisatie(s) waarvan de gebruiker actief lid is.
//   2. Device-token (hardware/Plaud-achtig prototype): X-Device-Token: <token>
//      → lookup op sha256(token) in devices; scope = org/lid van het device.
//   3. Integratie-secret (Recall-webhook, server-to-server): X-Capture-Secret
//      → mag alles, incl. action 'transcript'.
//
// Acties: context | start | complete | transcript
// Secrets: CAPTURE_INGEST_SECRET (alleen nodig voor pad 3)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BUCKET = 'recordings'
const EXT_OK = ['m4a', 'mp3', 'wav', 'webm', 'mp4', 'aac', 'ogg']

// CORS: browser-clients (Expo web / Replit) sturen een OPTIONS-preflight
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-device-token, x-capture-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface Caller {
  kind: 'secret' | 'user' | 'device'
  memberId?: string | null
  deviceId?: string | null
  orgIds?: string[] | null      // null = alles (secret-pad)
  memberByOrg?: Record<string, string>
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function resolveCaller(req: Request, sb: any): Promise<Caller | null> {
  const secret = (Deno.env.get('CAPTURE_INGEST_SECRET') ?? '').trim()
  if (secret && (req.headers.get('x-capture-secret') ?? '') === secret) {
    return { kind: 'secret', orgIds: null }
  }

  const deviceToken = (req.headers.get('x-device-token') ?? '').trim()
  if (deviceToken) {
    const hash = await sha256hex(deviceToken)
    const { data: dev } = await sb.from('devices')
      .select('id, org_id, member_id, is_active').eq('token_hash', hash).maybeSingle()
    if (!dev?.is_active) return null
    await sb.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', dev.id)
    return {
      kind: 'device', deviceId: dev.id, memberId: dev.member_id,
      orgIds: [dev.org_id], memberByOrg: dev.member_id ? { [dev.org_id]: dev.member_id } : {},
    }
  }

  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!jwt) return null
  const { data, error } = await sb.auth.getUser(jwt)
  if (error || !data?.user?.id) return null
  const { data: mems } = await sb.from('members')
    .select('id, org_id').eq('user_id', data.user.id).eq('is_active', true)
  if (!mems?.length) return null
  const memberByOrg: Record<string, string> = {}
  for (const m of mems) memberByOrg[m.org_id] = m.id
  return { kind: 'user', orgIds: mems.map((m: any) => m.org_id), memberByOrg }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const caller = await resolveCaller(req, sb)
  if (!caller) return json({ ok: false, error: 'unauthorized' }, 401)

  let body: any = {}
  try { body = await req.json() } catch {
    return json({ ok: false, error: 'JSON-body vereist' }, 400)
  }

  const orgAllowed = (org: string) => caller.orgIds === null || (caller.orgIds ?? []).includes(org)

  try {
    switch (body?.action) {
      case 'context': {
        if (caller.kind === 'secret') return json({ ok: false, error: 'context is niet voor het secret-pad' }, 400)
        const { data: orgs } = await sb.from('organizations')
          .select('id, name').in('id', caller.orgIds ?? []).order('name')
        return json({ ok: true, orgs: orgs ?? [], member_by_org: caller.memberByOrg ?? {} })
      }

      case 'start': {
        let orgId = body.org_id
        if (!orgId && caller.orgIds?.length === 1) orgId = caller.orgIds[0]
        if (!orgId || !body.recording_type || !body.started_at) {
          return json({ ok: false, error: 'org_id, recording_type en started_at zijn verplicht' }, 400)
        }
        if (!orgAllowed(orgId)) return json({ ok: false, error: 'geen toegang tot deze organisatie' }, 403)
        const memberId = body.member_id ?? caller.memberByOrg?.[orgId] ?? null

        const ext = EXT_OK.includes(String(body.ext)) ? body.ext : 'm4a'
        const { data: rec, error } = await sb.from('recordings').insert({
          org_id:           orgId,
          member_id:        memberId,
          device_id:        caller.deviceId ?? body.device_id ?? null,
          recording_type:   body.recording_type,
          meeting_platform: body.meeting_platform ?? null,
          title:            body.title ?? null,
          started_at:       body.started_at,
        }).select('id').single()
        if (error) throw new Error(error.message)

        const storage_path = `${orgId}/${rec.id}.${ext}`
        const { data: up, error: upErr } = await sb.storage.from(BUCKET).createSignedUploadUrl(storage_path)
        if (upErr) throw new Error(upErr.message)
        await sb.from('recordings').update({ storage_path }).eq('id', rec.id)

        console.log(`ingest: start ${rec.id} (${body.recording_type}, org ${orgId}, via ${caller.kind})`)
        return json({ ok: true, recording_id: rec.id, storage_path, upload_url: up.signedUrl, token: up.token })
      }

      case 'complete': {
        if (!body.recording_id) return json({ ok: false, error: 'recording_id verplicht' }, 400)
        const { data: rec } = await sb.from('recordings')
          .select('id, org_id').eq('id', body.recording_id).maybeSingle()
        if (!rec) return json({ ok: false, error: 'opname niet gevonden' }, 404)
        if (!orgAllowed(rec.org_id)) return json({ ok: false, error: 'geen toegang' }, 403)

        const patch: any = { status: 'uploaded' }
        if (body.ended_at)         patch.ended_at = body.ended_at
        if (body.duration_seconds) patch.duration_seconds = body.duration_seconds
        if (body.consent_status)   patch.consent_status = body.consent_status
        const { error } = await sb.from('recordings').update(patch).eq('id', body.recording_id)
        if (error) throw new Error(error.message)

        if (body.consent_status && body.consent_method) {
          await sb.from('consents').insert({
            recording_id: body.recording_id,
            method:       body.consent_method,
            confirmed_by: body.consent_confirmed_by ?? null,
            details:      body.consent_details ?? null,
          })
        }
        console.log(`ingest: complete ${body.recording_id} (via ${caller.kind})`)
        return json({ ok: true })
      }

      case 'transcript': {
        if (caller.kind !== 'secret') return json({ ok: false, error: 'transcript is alleen voor het secret-pad' }, 403)
        if (!body.recording_id || !body.full_text) {
          return json({ ok: false, error: 'recording_id en full_text verplicht' }, 400)
        }
        const { error } = await sb.rpc('register_transcript', {
          p_recording_id: body.recording_id,
          p_full_text:    body.full_text,
          p_segments:     body.segments ?? null,
          p_language:     body.language ?? null,
          p_provider:     body.provider ?? 'integration',
        })
        if (error) throw new Error(error.message)
        return json({ ok: true })
      }

      default:
        return json({ ok: false, error: "action moet 'context', 'start', 'complete' of 'transcript' zijn" }, 400)
    }
  } catch (e) {
    console.error(`ingest-recording: ${e}`)
    return json({ ok: false, error: String(e).slice(0, 500) }, 500)
  }
})

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}
