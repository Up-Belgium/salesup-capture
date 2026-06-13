// ============================================================================
// salesUp Capture — sync-calendars (Recall Calendar V2)
// ============================================================================
// "Automatisch starten zodra de meeting start" voor de bot-route, enterprise-
// veilig: leden verbinden hun agenda via OAuth (zie calendar-oauth), Recall
// beheert de tokens en synchroniseert de events. Deze functie haalt per
// verbonden lid de events op die nu beginnen (venster -10/+20 min) met een
// videocall-link en plant er via Recall automatisch de zichtbare bot voor in.
// Transcript komt daarna binnen via poll-bots. Cron: elke 5 minuten.
//
// Dedupe: recordings.calendar_event_uid = Recall calendar-event-id.
// Secrets: RECALL_API_KEY (+ RECALL_API_URL, default eu-central-1)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const WINDOW_BEFORE_MIN = 10
const WINDOW_AHEAD_MIN = 20

function botIdOf(resp: any): string | null {
  return resp?.bot_id ?? resp?.id ?? resp?.bot?.id ?? resp?.bots?.[0]?.bot_id ?? resp?.bots?.[0]?.id ?? null
}

function platformOf(url: string): string {
  return /meet\.google/.test(url) ? 'google_meet'
       : /zoom\./.test(url) ? 'zoom'
       : /teams\./.test(url) ? 'teams'
       : /webex\./.test(url) ? 'webex' : 'other'
}

Deno.serve(async (req) => {
  const recallKey = (Deno.env.get('RECALL_API_KEY') ?? '').trim()
  if (!recallKey) return json({ ok: false, error: 'RECALL_API_KEY niet gezet als Edge Function secret' }, 500)
  const recallUrl = (Deno.env.get('RECALL_API_URL') ?? 'https://eu-central-1.recall.ai').trim()
  const recallHeaders = { Authorization: `Token ${recallKey}`, 'Content-Type': 'application/json' }

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: membersList } = await sb.from('members')
    .select('id, org_id, full_name, recall_calendar_id')
    .not('recall_calendar_id', 'is', null)
    .eq('is_active', true)

  let dbg: any = null
  try { dbg = (await req.clone().json())?.debug ? true : null } catch { /* */ }

  // Diagnose-modus: privacyveilig (geen titels/inhoud) — toont of events met
  // videocall-link binnenkomen en onder welk veld de link zit.
  if (dbg) {
    const out: any[] = []
    const gte = new Date(Date.now() - 60 * 60_000).toISOString()
    const lte = new Date(Date.now() + 24 * 3600_000).toISOString()
    for (const m of membersList ?? []) {
      // kalender-object: status/sync-state (connected, connecting, disconnected, error)
      const cr = await fetch(`${recallUrl}/api/v2/calendars/${m.recall_calendar_id}/`, { headers: recallHeaders })
      const cj = await cr.json().catch(() => ({}))
      const r = await fetch(`${recallUrl}/api/v2/calendar-events/?calendar_id=${m.recall_calendar_id}&start_time__gte=${gte}&start_time__lte=${lte}`, { headers: recallHeaders })
      const j = await r.json().catch(() => ({}))
      const evs = Array.isArray(j?.results) ? j.results : (Array.isArray(j) ? j : [])
      out.push({
        member: m.full_name,
        calendar_http: cr.status,
        calendar_status: cj?.status ?? cj?.state ?? null,
        calendar_error: cj?.status_changes?.slice?.(-1)?.[0] ?? cj?.error ?? null,
        http: r.status, event_count: evs.length,
        sample_keys: evs[0] ? Object.keys(evs[0]) : [],
        events: evs.slice(0, 10).map((e: any) => ({
          start_time: e?.start_time,
          has_meeting_url: !!(e?.meeting_url ?? e?.meeting_platform_url),
          meeting_url_field: e?.meeting_url != null ? 'meeting_url' : (e?.meeting_platform_url != null ? 'meeting_platform_url' : null),
          is_deleted: e?.is_deleted ?? false,
        })),
      })
    }
    return json({ ok: true, debug: out })
  }

  const now = Date.now()
  const gte = new Date(now - WINDOW_BEFORE_MIN * 60_000).toISOString()
  const lte = new Date(now + WINDOW_AHEAD_MIN * 60_000).toISOString()

  let scheduled = 0, skipped = 0, errors = 0
  for (const m of membersList ?? []) {
    try {
      const evRes = await fetch(
        `${recallUrl}/api/v2/calendar-events/?calendar_id=${m.recall_calendar_id}&start_time__gte=${gte}&start_time__lte=${lte}`,
        { headers: recallHeaders },
      )
      if (!evRes.ok) throw new Error(`list-events ${evRes.status}: ${(await evRes.text()).slice(0, 150)}`)
      const evJson = await evRes.json()
      const events = Array.isArray(evJson?.results) ? evJson.results : (Array.isArray(evJson) ? evJson : [])

      for (const ev of events) {
        if (ev?.is_deleted) continue
        const meetingUrl: string | null = ev?.meeting_url ?? ev?.meeting_platform_url ?? null
        if (!meetingUrl || !meetingUrl.startsWith('http')) continue

        const { data: existing } = await sb.from('recordings')
          .select('id').eq('member_id', m.id).eq('calendar_event_uid', ev.id).maybeSingle()
        if (existing) { skipped++; continue }

        const botRes = await fetch(`${recallUrl}/api/v2/calendar-events/${ev.id}/bot/`, {
          method: 'POST',
          headers: recallHeaders,
          body: JSON.stringify({
            deduplication_key: `salesup-${ev.id}`,
            bot_config: {
              bot_name: 'salesUp Capture',
              recording_config: {
                transcript: { provider: { recallai_streaming: { mode: 'prioritize_accuracy', language_code: 'auto' } } },
              },
            },
          }),
        })
        if (!botRes.ok) throw new Error(`schedule-bot ${botRes.status}: ${(await botRes.text()).slice(0, 150)}`)
        const botId = botIdOf(await botRes.json())

        const { data: rec, error } = await sb.from('recordings').insert({
          org_id:             m.org_id,
          member_id:          m.id,
          recording_type:     'video_meeting',
          meeting_platform:   platformOf(meetingUrl),
          title:              ev?.raw?.summary ?? ev?.title ?? null,
          started_at:         ev?.start_time ?? new Date().toISOString(),
          external_ref:       botId ? `bot:${botId}` : `calevent:${ev.id}`,
          calendar_event_uid: ev.id,
          consent_status:     'informed',
        }).select('id').single()
        if (error) throw new Error(error.message)

        await sb.from('consents').insert({
          recording_id: rec.id,
          method:       'platform_banner',
          details:      'Automatisch via verbonden agenda; zichtbare bot "salesUp Capture" in de meeting.',
        })
        scheduled++
        console.log(`sync-calendars: bot gepland voor event ${ev.id} (${m.full_name})`)
      }
    } catch (e) {
      errors++
      console.error(`sync-calendars: lid ${m.id}: ${e}`)
    }
  }

  console.log(`sync-calendars: leden=${(membersList ?? []).length} gepland=${scheduled} dedupe=${skipped} fouten=${errors}`)
  return json({ ok: true, members: (membersList ?? []).length, scheduled, skipped, errors })
})

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
