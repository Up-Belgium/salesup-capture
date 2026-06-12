// ============================================================================
// salesUp Capture — sync-calendars
// ============================================================================
// "Automatisch starten zodra de meeting start" voor de bot-route, zonder
// OAuth: elk lid kan de geheime iCal-URL van zijn agenda instellen
// (members.calendar_ics_url). Deze functie leest die feeds elke 5 minuten,
// zoekt events die nu beginnen (venster -10/+20 min) met een
// Meet/Zoom/Teams/Webex-link, en stuurt er automatisch de zichtbare bot op af.
// Dedupe via recordings.calendar_event_uid.
//
// Beperkingen v1 (gelogd, geen fout): terugkerende events (RRULE) worden niet
// uitgevouwen; tijden worden als UTC gelezen (Google's geheime iCal levert UTC).
//
// Secrets: RECALL_API_KEY (+ RECALL_API_URL, default eu-central-1)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const WINDOW_BEFORE_MIN = 10  // events die max 10 min geleden begonnen
const WINDOW_AHEAD_MIN = 20   // of binnen 20 min beginnen

const MEETING_URL_RE = /(https:\/\/(?:[\w.-]*\.)?(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com)\/[^\s">\\,]+)/i

interface IcsEvent { uid: string; start: Date | null; summary: string; url: string | null; rrule: boolean }

// Minimale ICS-parser: unfold + VEVENT-velden. Google's geheime iCal gebruikt
// UTC-tijden (…Z); andere vormen worden best-effort als UTC gelezen.
function parseIcs(text: string): IcsEvent[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '')
  const lines = unfolded.split(/\r?\n/)
  const events: IcsEvent[] = []
  let cur: any = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { uid: '', start: null, summary: '', blob: '', rrule: false }; continue }
    if (line === 'END:VEVENT') {
      if (cur) {
        const m = String(cur.blob).match(MEETING_URL_RE)
        events.push({
          uid: cur.uid, start: cur.start, summary: cur.summary,
          url: m ? m[1].replace(/\\/g, '') : null, rrule: cur.rrule,
        })
      }
      cur = null; continue
    }
    if (!cur) continue
    cur.blob += line + '\n'
    if (line.startsWith('UID:')) cur.uid = line.slice(4).trim()
    else if (line.startsWith('SUMMARY:')) cur.summary = line.slice(8).trim()
    else if (line.startsWith('RRULE:')) cur.rrule = true
    else if (line.startsWith('DTSTART')) {
      const v = line.split(':').pop()?.trim() ?? ''
      const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/)
      if (m) cur.start = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
    }
  }
  return events
}

Deno.serve(async (req) => {
  const recallKey = (Deno.env.get('RECALL_API_KEY') ?? '').trim()
  if (!recallKey) return json({ ok: false, error: 'RECALL_API_KEY niet gezet als Edge Function secret' }, 500)
  const recallUrl = (Deno.env.get('RECALL_API_URL') ?? 'https://eu-central-1.recall.ai').trim()

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: membersList } = await sb.from('members')
    .select('id, org_id, full_name, calendar_ics_url')
    .not('calendar_ics_url', 'is', null)
    .eq('is_active', true)

  const now = Date.now()
  let scheduled = 0, skipped = 0, errors = 0
  for (const m of membersList ?? []) {
    try {
      const res = await fetch(m.calendar_ics_url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`iCal ${res.status}`)
      const events = parseIcs(await res.text())

      for (const ev of events) {
        if (!ev.url || !ev.start || !ev.uid) continue
        if (ev.rrule) continue // v1: terugkerende reeksen niet uitvouwen
        const delta = ev.start.getTime() - now
        if (delta < -WINDOW_BEFORE_MIN * 60_000 || delta > WINDOW_AHEAD_MIN * 60_000) continue

        const eventKey = `${ev.uid}@${ev.start.toISOString()}`
        const { data: existing } = await sb.from('recordings')
          .select('id').eq('member_id', m.id).eq('calendar_event_uid', eventKey).maybeSingle()
        if (existing) { skipped++; continue }

        const botRes = await fetch(`${recallUrl}/api/v1/bot/`, {
          method: 'POST',
          headers: { Authorization: `Token ${recallKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            meeting_url: ev.url,
            bot_name: 'salesUp Capture',
            ...(delta > 2 * 60_000 ? { join_at: ev.start.toISOString() } : {}),
            recording_config: {
              transcript: { provider: { recallai_streaming: { mode: 'prioritize_accuracy', language_code: 'auto' } } },
            },
          }),
        })
        if (!botRes.ok) throw new Error(`Recall ${botRes.status}: ${(await botRes.text()).slice(0, 150)}`)
        const bot = await botRes.json()

        const { data: rec, error } = await sb.from('recordings').insert({
          org_id:             m.org_id,
          member_id:          m.id,
          recording_type:     'video_meeting',
          meeting_platform:   /meet\.google/.test(ev.url) ? 'google_meet'
                            : /zoom\./.test(ev.url) ? 'zoom'
                            : /teams\./.test(ev.url) ? 'teams' : 'webex',
          title:              ev.summary || null,
          started_at:         ev.start.toISOString(),
          external_ref:       `bot:${bot.id}`,
          calendar_event_uid: eventKey,
          consent_status:     'informed',
        }).select('id').single()
        if (error) throw new Error(error.message)

        await sb.from('consents').insert({
          recording_id: rec.id,
          method:       'platform_banner',
          details:      'Automatisch via agenda-koppeling; zichtbare bot "salesUp Capture" in de meeting.',
        })
        scheduled++
        console.log(`sync-calendars: bot gepland voor "${ev.summary}" (${m.full_name})`)
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
