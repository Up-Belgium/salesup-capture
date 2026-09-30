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
// Acties: context | start | append | reupload | complete | transcript
//         match_orphans (mobiele app: lokale bestanden koppelen aan opnames)
//         recall_start (sdk_upload aanmaken) | recall_transcript (realtime-
//         transcript uit de Recall Desktop SDK, alleen eigen-org-opnames)
//
// Idempotentie (duurzame upload-wachtrij in de mobiele app, fix/durable-upload):
//   - start met client_ref  → zelfde client_ref = zelfde opname (geen dubbele rij
//     als het antwoord onderweg verloren ging); opgeslagen als external_ref 'app:<ref>'.
//   - append met segment_no → bestaand segmentpad hergebruiken bij een retry.
//   - reupload              → verse signed upload-URL (upsert) voor een bestaand pad.
//   - complete              → wijzigt de status enkel vanuit pending_upload/error,
//     zodat een herhaalde complete een getranscribeerde opname niet terugzet.
// Secrets: CAPTURE_INGEST_SECRET (pad 3) · RECALL_API_KEY + RECALL_API_URL
//          (alleen voor recall_start; URL default us-west-2)
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

        // Optionele client_ref (lokale id uit de upload-wachtrij van de app): als
        // er al een opname met dezelfde ref bestaat (vorige poging kreeg geen
        // antwoord), geven we DIE terug met een verse upsert-URL i.p.v. een
        // tweede rij aan te maken die anders eeuwig op pending_upload blijft.
        const clientRef = typeof body.client_ref === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.client_ref)
          ? `app:${body.client_ref}` : null
        const ext = EXT_OK.includes(String(body.ext)) ? body.ext : 'm4a'
        if (clientRef) {
          const { data: existing } = await sb.from('recordings')
            .select('id, org_id, storage_path').eq('external_ref', clientRef).eq('org_id', orgId)
            .order('created_at', { ascending: true }).limit(1).maybeSingle()
          if (existing) {
            const path = existing.storage_path ?? `${orgId}/${existing.id}.${ext}`
            const { data: up, error: upErr } = await sb.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true })
            if (upErr) throw new Error(upErr.message)
            if (!existing.storage_path) await sb.from('recordings').update({ storage_path: path }).eq('id', existing.id)
            console.log(`ingest: start (herhaald, client_ref) ${existing.id} (via ${caller.kind})`)
            return json({
              ok: true, recording_id: existing.id, storage_path: path,
              upload_url: up.signedUrl, token: up.token, reused: true,
            })
          }
        }

        const { data: rec, error } = await sb.from('recordings').insert({
          org_id:           orgId,
          member_id:        memberId,
          device_id:        caller.deviceId ?? body.device_id ?? null,
          recording_type:   body.recording_type,
          meeting_platform: body.meeting_platform ?? null,
          title:            body.title ?? null,
          started_at:       body.started_at,
          external_ref:     clientRef,
        }).select('id').single()
        if (error) throw new Error(error.message)

        const storage_path = `${orgId}/${rec.id}.${ext}`
        const { data: up, error: upErr } = await sb.storage.from(BUCKET).createSignedUploadUrl(storage_path)
        if (upErr) throw new Error(upErr.message)
        await sb.from('recordings').update({ storage_path }).eq('id', rec.id)

        console.log(`ingest: start ${rec.id} (${body.recording_type}, org ${orgId}, via ${caller.kind})`)
        return json({ ok: true, recording_id: rec.id, storage_path, upload_url: up.signedUrl, token: up.token })
      }

      case 'append': {
        // Extra audiosegment aan een BESTAANDE opname toevoegen (na een
        // onderbreking, bv. een oproep). Geen nieuwe recordings-rij: we maken enkel
        // een nieuw storage-pad + upload-URL en hangen dat pad aan segment_paths.
        // transcribe-recordings plakt storage_path + segment_paths later aan elkaar
        // tot één transcript/verslag.
        if (!body.recording_id) return json({ ok: false, error: 'recording_id verplicht' }, 400)
        const { data: rec } = await sb.from('recordings')
          .select('id, org_id, segment_paths').eq('id', body.recording_id).maybeSingle()
        if (!rec) return json({ ok: false, error: 'opname niet gevonden' }, 404)
        if (!orgAllowed(rec.org_id)) return json({ ok: false, error: 'geen toegang' }, 403)

        // Idempotente retry: de app stuurt segment_no mee (1 = eerste extra
        // segment). Bestaat dat segment al (vorige poging kreeg geen antwoord of
        // de upload faalde), dan hergebruiken we het pad met een upsert-URL i.p.v.
        // een nieuw (leeg) pad toe te voegen dat de transcriptie zou breken.
        const existingPaths: string[] = rec.segment_paths ?? []
        const segNo = Number(body.segment_no)
        if (Number.isInteger(segNo) && segNo >= 1 && segNo <= existingPaths.length) {
          const reusePath = existingPaths[segNo - 1]
          const { data: up, error: upErr } = await sb.storage.from(BUCKET).createSignedUploadUrl(reusePath, { upsert: true })
          if (upErr) throw new Error(upErr.message)
          console.log(`ingest: append seg ${segNo} (herhaald) → ${rec.id} (via ${caller.kind})`)
          return json({ ok: true, recording_id: rec.id, storage_path: reusePath, upload_url: up.signedUrl, token: up.token, reused: true })
        }

        const ext = EXT_OK.includes(String(body.ext)) ? body.ext : 'm4a'
        const segNr = existingPaths.length + 1
        const seg_path = `${rec.org_id}/${rec.id}/seg-${segNr}.${ext}`
        const { data: up, error: upErr } = await sb.storage.from(BUCKET).createSignedUploadUrl(seg_path)
        if (upErr) throw new Error(upErr.message)
        const paths = [...(rec.segment_paths ?? []), seg_path]
        const { error: updErr } = await sb.from('recordings').update({ segment_paths: paths }).eq('id', rec.id)
        if (updErr) throw new Error(updErr.message)

        console.log(`ingest: append seg ${segNr} → ${rec.id} (via ${caller.kind})`)
        return json({ ok: true, recording_id: rec.id, storage_path: seg_path, upload_url: up.signedUrl, token: up.token })
      }

      case 'reupload': {
        // Verse signed upload-URL (upsert) voor een BESTAAND pad van een opname:
        // het hoofdbestand (storage_path) of een extra segment (segment_paths).
        // Gebruikt door de upload-wachtrij van de app als een eerdere PUT mislukte
        // — zo komt het bestand alsnog op exact het pad waar transcriptie het zoekt.
        if (!body.recording_id) return json({ ok: false, error: 'recording_id verplicht' }, 400)
        const { data: rec } = await sb.from('recordings')
          .select('id, org_id, status, storage_path, segment_paths').eq('id', body.recording_id).maybeSingle()
        if (!rec) return json({ ok: false, error: 'opname niet gevonden' }, 404)
        if (!orgAllowed(rec.org_id)) return json({ ok: false, error: 'geen toegang' }, 403)
        if (!['pending_upload', 'error'].includes(rec.status)) {
          return json({ ok: false, error: `opname is al verwerkt (status ${rec.status})` }, 409)
        }
        const path = body.storage_path ? String(body.storage_path) : rec.storage_path
        if (!path) return json({ ok: false, error: 'opname heeft geen storage_path' }, 400)
        if (path !== rec.storage_path && !(rec.segment_paths ?? []).includes(path)) {
          return json({ ok: false, error: 'storage_path hoort niet bij deze opname' }, 400)
        }
        const { data: up, error: upErr } = await sb.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true })
        if (upErr) throw new Error(upErr.message)
        console.log(`ingest: reupload ${rec.id} → ${path} (via ${caller.kind})`)
        return json({ ok: true, recording_id: rec.id, storage_path: path, upload_url: up.signedUrl, token: up.token })
      }

      case 'match_orphans': {
        // De app vond lokale audiobestanden die niet in haar wachtrij staan (bv.
        // een mislukte upload uit een oudere app-versie). Oude versies riepen
        // 'start' aan meteen NA het stoppen van de opname, dus created_at van de
        // opname ≈ wijzigingstijd van het bestand. Per bestand geven we de best
        // passende eigen opname terug (binnen 15 min) + of het bestand al in
        // storage staat, zodat de app weet: redden (reupload), al verstuurd
        // (verbergen) of onbekend (als nieuwe opname aanbieden).
        if (caller.kind !== 'user') return json({ ok: false, error: 'match_orphans is alleen voor ingelogde gebruikers' }, 403)
        const files: any[] = Array.isArray(body.files) ? body.files.slice(0, 50) : []
        const memberIds = Object.values(caller.memberByOrg ?? {})
        const times = files.map((f) => new Date(f?.modified_at).getTime()).filter((t) => isFinite(t))
        if (files.length === 0 || times.length === 0 || memberIds.length === 0) return json({ ok: true, matches: [] })
        const WINDOW_MS = 15 * 60_000
        const { data: recs } = await sb.from('recordings')
          .select('id, org_id, status, storage_path, created_at, started_at, title, recording_type')
          // enkel opnames met een lokaal bestand (geen Recall-bots/SDK-opnames)
          .in('member_id', memberIds).or('external_ref.is.null,external_ref.like.app:%')
          .gte('created_at', new Date(Math.min(...times) - WINDOW_MS).toISOString())
          .lte('created_at', new Date(Math.max(...times) + WINDOW_MS).toISOString())
          .limit(500)
        const matches = []
        for (const f of files) {
          const t = new Date(f?.modified_at).getTime()
          let best: any = null, bestDiff = Infinity
          for (const r of recs ?? []) {
            const diff = Math.abs(new Date(r.created_at).getTime() - t)
            if (diff <= WINDOW_MS && diff < bestDiff) { best = r; bestDiff = diff }
          }
          if (!best) { matches.push({ key: String(f?.key ?? ''), match: null }); continue }
          const hasFile = best.storage_path ? await objectExists(sb, best.storage_path) : false
          matches.push({
            key: String(f?.key ?? ''),
            match: {
              recording_id: best.id, org_id: best.org_id, status: best.status, has_file: hasFile,
              storage_path: best.storage_path, started_at: best.started_at,
              title: best.title, recording_type: best.recording_type,
            },
          })
        }
        console.log(`ingest: match_orphans ${files.length} bestand(en), ${matches.filter((m) => m.match).length} gekoppeld`)
        return json({ ok: true, matches })
      }

      case 'complete': {
        if (!body.recording_id) return json({ ok: false, error: 'recording_id verplicht' }, 400)
        const { data: rec } = await sb.from('recordings')
          .select('id, org_id, status').eq('id', body.recording_id).maybeSingle()
        if (!rec) return json({ ok: false, error: 'opname niet gevonden' }, 404)
        if (!orgAllowed(rec.org_id)) return json({ ok: false, error: 'geen toegang' }, 403)

        // Idempotent: een herhaalde complete (antwoord onderweg verloren) mag een
        // opname die al in de pipeline zit niet terugzetten naar 'uploaded'
        // (dat zou opnieuw transcriberen + een tweede mail geven). Vanuit 'error'
        // mag het wél (bv. alsnog verstuurd na de sweep-pending-uploads-grens).
        if (!['pending_upload', 'error'].includes(rec.status)) {
          console.log(`ingest: complete ${body.recording_id} genegeerd (status ${rec.status}, via ${caller.kind})`)
          return json({ ok: true, already: true })
        }

        const patch: any = { status: 'uploaded', error: null }
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

      case 'recall_start': {
        // Recall.ai Desktop SDK: server-side sdk_upload aanmaken (key blijft
        // server-side) en koppelen aan een recordings-rij. App ontvangt het
        // upload_token en start de SDK-opname (volledige systeemaudio).
        if (caller.kind !== 'user') return json({ ok: false, error: 'recall_start is alleen voor ingelogde gebruikers' }, 403)
        const recallKey = (Deno.env.get('RECALL_API_KEY') ?? '').trim()
        if (!recallKey) return json({ ok: false, error: 'RECALL_API_KEY niet gezet als Edge Function secret' }, 500)
        // Stigs Recall-account is in de EU-regio aangemaakt (2026-06-11)
        const recallUrl = (Deno.env.get('RECALL_API_URL') ?? 'https://eu-central-1.recall.ai').trim()

        let orgId = body.org_id
        if (!orgId && caller.orgIds?.length === 1) orgId = caller.orgIds[0]
        if (!orgId || !orgAllowed(orgId)) return json({ ok: false, error: 'geen toegang tot deze organisatie' }, 403)

        const res = await fetch(`${recallUrl}/api/v1/sdk_upload/`, {
          method: 'POST',
          headers: { Authorization: `Token ${recallKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recording_config: {
              // Recall's eigen transcriptie: geen externe provider-credentials
              // nodig; accuracy-modus + auto-taal (Nederlands wordt herkend).
              transcript: { provider: { recallai_streaming: { mode: 'prioritize_accuracy', language_code: 'auto' } } },
              realtime_endpoints: [{
                type: 'desktop_sdk_callback',
                events: ['transcript.data', 'participant_events.join'],
              }],
            },
          }),
        })
        if (!res.ok) throw new Error(`Recall ${res.status}: ${(await res.text()).slice(0, 200)}`)
        const sdkUpload = await res.json()

        const { data: rec, error } = await sb.from('recordings').insert({
          org_id:           orgId,
          member_id:        caller.memberByOrg?.[orgId] ?? null,
          recording_type:   'video_meeting',
          meeting_platform: body.meeting_platform ?? null,
          title:            body.title ?? null,
          started_at:       body.started_at ?? new Date().toISOString(),
          external_ref:     String(sdkUpload.id ?? ''),
        }).select('id').single()
        if (error) throw new Error(error.message)

        console.log(`ingest: recall_start ${rec.id} (org ${orgId}, sdk_upload ${sdkUpload.id})`)
        return json({ ok: true, recording_id: rec.id, upload_token: sdkUpload.upload_token })
      }

      case 'bot_start': {
        // Zichtbare meeting-bot (Leexi-model): geen installatie per gebruiker.
        // De bot joint de meeting, neemt op in de Recall-cloud; poll-bots haalt
        // daarna het transcript op. De zichtbare bot geldt als consent-melding
        // richting alle deelnemers.
        if (caller.kind !== 'user') return json({ ok: false, error: 'bot_start is alleen voor ingelogde gebruikers' }, 403)
        const recallKey = (Deno.env.get('RECALL_API_KEY') ?? '').trim()
        if (!recallKey) return json({ ok: false, error: 'RECALL_API_KEY niet gezet als Edge Function secret' }, 500)
        const recallUrl = (Deno.env.get('RECALL_API_URL') ?? 'https://eu-central-1.recall.ai').trim()

        const meetingUrl = String(body.meeting_url ?? '').trim()
        if (!meetingUrl.startsWith('http')) return json({ ok: false, error: 'meeting_url (volledige link) is verplicht' }, 400)
        let orgId = body.org_id
        if (!orgId && caller.orgIds?.length === 1) orgId = caller.orgIds[0]
        if (!orgId || !orgAllowed(orgId)) return json({ ok: false, error: 'geen toegang tot deze organisatie' }, 403)

        const platform =
          /meet\.google/.test(meetingUrl) ? 'google_meet' :
          /zoom\./.test(meetingUrl) ? 'zoom' :
          /teams\./.test(meetingUrl) ? 'teams' :
          /webex\./.test(meetingUrl) ? 'webex' : 'other'

        const res = await fetch(`${recallUrl}/api/v1/bot/`, {
          method: 'POST',
          headers: { Authorization: `Token ${recallKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            meeting_url: meetingUrl,
            bot_name: 'salesUp Capture',
            ...(body.join_at ? { join_at: body.join_at } : {}),
            recording_config: {
              transcript: { provider: { recallai_streaming: { mode: 'prioritize_accuracy', language_code: 'auto' } } },
            },
          }),
        })
        if (!res.ok) throw new Error(`Recall ${res.status}: ${(await res.text()).slice(0, 200)}`)
        const bot = await res.json()

        const { data: rec, error } = await sb.from('recordings').insert({
          org_id:           orgId,
          member_id:        caller.memberByOrg?.[orgId] ?? null,
          recording_type:   'video_meeting',
          meeting_platform: platform,
          title:            body.title ?? null,
          started_at:       body.join_at ?? new Date().toISOString(),
          external_ref:     `bot:${bot.id}`,
          consent_status:   'informed',
        }).select('id').single()
        if (error) throw new Error(error.message)

        await sb.from('consents').insert({
          recording_id: rec.id,
          method:       'platform_banner',
          details:      'Zichtbare bot "salesUp Capture" in de meeting — alle deelnemers zien de opname.',
        })

        console.log(`ingest: bot_start ${rec.id} (bot ${bot.id}, ${platform}, org ${orgId})`)
        return json({ ok: true, recording_id: rec.id, bot_id: bot.id })
      }

      case 'recall_transcript': {
        // Realtime-transcript uit de Recall SDK (in de app verzameld).
        // Alleen voor eigen-org-opnames die via recall_start zijn aangemaakt.
        if (caller.kind === 'secret') return json({ ok: false, error: 'gebruik action transcript voor het secret-pad' }, 400)
        if (!body.recording_id || !Array.isArray(body.segments) || body.segments.length === 0) {
          return json({ ok: false, error: 'recording_id en segments verplicht' }, 400)
        }
        const { data: rec } = await sb.from('recordings')
          .select('id, org_id, external_ref').eq('id', body.recording_id).maybeSingle()
        if (!rec) return json({ ok: false, error: 'opname niet gevonden' }, 404)
        if (!orgAllowed(rec.org_id)) return json({ ok: false, error: 'geen toegang' }, 403)
        if (!rec.external_ref || String(rec.external_ref).startsWith('app:')) {
          return json({ ok: false, error: 'geen Recall-opname (external_ref ontbreekt)' }, 400)
        }

        const segments = body.segments
          .map((s: any) => ({
            speaker: s?.speaker ? String(s.speaker) : null,
            start_s: typeof s?.start_s === 'number' ? s.start_s : null,
            end_s:   typeof s?.end_s === 'number' ? s.end_s : null,
            text:    String(s?.text ?? '').trim(),
          }))
          .filter((s: any) => s.text.length > 0)
        const fullText = segments
          .map((s: any) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n')

        const { error } = await sb.rpc('register_transcript', {
          p_recording_id: body.recording_id,
          p_full_text:    fullText,
          p_segments:     segments,
          p_language:     body.language ?? null,
          p_provider:     'recall_sdk',
        })
        if (error) throw new Error(error.message)
        console.log(`ingest: recall_transcript ${body.recording_id} (${segments.length} segmenten, via ${caller.kind})`)
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
        return json({ ok: false, error: "action moet 'context', 'start', 'append', 'reupload', 'complete', 'match_orphans' of 'transcript' zijn" }, 400)
    }
  } catch (e) {
    console.error(`ingest-recording: ${e}`)
    return json({ ok: false, error: String(e).slice(0, 500) }, 500)
  }
})

// Bestaat er een object op dit pad in de recordings-bucket? (storage list op de
// map + exacte naamvergelijking; search is een deel-match.)
async function objectExists(sb: any, path: string): Promise<boolean> {
  const i = path.lastIndexOf('/')
  const dir = i >= 0 ? path.slice(0, i) : ''
  const name = i >= 0 ? path.slice(i + 1) : path
  const { data, error } = await sb.storage.from(BUCKET).list(dir, { search: name, limit: 10 })
  if (error) throw new Error(`storage list: ${error.message}`)
  return (data ?? []).some((o: any) => o?.name === name && o?.id)
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}
