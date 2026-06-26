// ============================================================================
// salesUp Capture — notify-meetings
// ============================================================================
// Stuurt ~5 min vóór een EXTERNE FACE-TO-FACE meeting (externe zakelijke
// deelnemer, GEEN videolink) een push naar de gebruiker om op te nemen.
// Bron: dezelfde Recall-agenda als sync-calendars. Idempotent via meeting_push_log.
// Cron: elke 5 min. Auth: verify_jwt=true (anon/service bearer vanuit cron).
// ============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const WINDOW_MIN = 6   // events die binnen 6 min starten (cron draait /5min)

const FREE_MAIL = new Set([
  'gmail.com','googlemail.com','hotmail.com','hotmail.be','hotmail.fr','hotmail.nl',
  'outlook.com','outlook.be','outlook.fr','live.com','live.be','live.nl',
  'icloud.com','me.com','mac.com','yahoo.com','yahoo.fr','yahoo.co.uk',
  'msn.com','aol.com','gmx.com','gmx.net','protonmail.com','proton.me',
  'telenet.be','skynet.be','proximus.be','scarlet.be','pandora.be',
])
function attendeeEmails(ev: any): string[] {
  const list = Array.isArray(ev?.raw?.attendees) ? ev.raw.attendees : []
  const out: string[] = []
  for (const a of list) {
    if (a?.resource) continue
    const e = (a?.email ?? a?.emailAddress?.address ?? '').toString().toLowerCase().trim()
    if (e && e.includes('@') && !e.endsWith('resource.calendar.google.com')) out.push(e)
  }
  return out
}
function isExternalBusiness(ev: any, ownDomain: string | null): boolean {
  const domains = attendeeEmails(ev).map((e) => e.split('@')[1]).filter(Boolean)
  if (domains.length === 0) return false
  return domains.some((d) => d !== ownDomain && !FREE_MAIL.has(d))
}
// Fysieke afspraak? = echt adres (geen videolink) — Google raw.location (string),
// Microsoft raw.location.displayName. Zulke events zijn F2F en horen een push te krijgen.
function eventLocation(ev: any): string {
  const raw = ev?.raw ?? {}
  return (typeof raw.location === 'string' ? raw.location : (raw.location?.displayName ?? '')).toString().trim()
}
function isInPerson(ev: any): boolean {
  const loc = eventLocation(ev)
  if (!loc || /^https?:\/\//i.test(loc) || /(meet\.google|zoom\.|teams\.|webex\.)/i.test(loc)) return false
  return true
}

async function sendPush(token: string, title: string, eventTitle: string): Promise<string> {
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      to: token,
      title: '🎙️ salesUp Capture',
      body: `Zo dadelijk: ${eventTitle}. Tik om op te nemen.`,
      sound: 'default', priority: 'high', channelId: 'meetings',
      data: { type: 'record' },
    }),
  })
  const j = await res.json().catch(() => ({}))
  const status = j?.data?.status ?? (res.ok ? 'ok' : `http_${res.status}`)
  return String(status)
}

Deno.serve(async () => {
  const recallKey = (Deno.env.get('RECALL_API_KEY') ?? '').trim()
  if (!recallKey) return json({ ok: false, error: 'RECALL_API_KEY ontbreekt' }, 500)
  const recallUrl = (Deno.env.get('RECALL_API_URL') ?? 'https://eu-central-1.recall.ai').trim()
  const headers = { Authorization: `Token ${recallKey}`, 'Content-Type': 'application/json' }
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: members } = await sb.from('members')
    .select('id, email, calendar_email, recall_calendar_id, expo_push_token')
    .not('recall_calendar_id', 'is', null).not('expo_push_token', 'is', null).eq('is_active', true)

  const now = Date.now()
  const gte = new Date(now).toISOString()
  const lte = new Date(now + WINDOW_MIN * 60_000).toISOString()
  let pushed = 0, skipped = 0, errors = 0

  for (const m of members ?? []) {
    try {
      const ownDomain = String(m.calendar_email ?? m.email ?? '').toLowerCase().split('@')[1] ?? null
      const r = await fetch(`${recallUrl}/api/v2/calendar-events/?calendar_id=${m.recall_calendar_id}&start_time__gte=${gte}&start_time__lte=${lte}`, { headers })
      if (!r.ok) { errors++; continue }
      const j = await r.json()
      const events = Array.isArray(j?.results) ? j.results : (Array.isArray(j) ? j : [])
      for (const ev of events) {
        if (ev?.is_deleted) continue
        if (!isExternalBusiness(ev, ownDomain)) continue
        const meetingUrl = ev?.meeting_url ?? ev?.meeting_platform_url ?? null
        // F2F = fysieke afspraak (echt adres) OF geen videolink (telefoon). Pure
        // videocall (link, geen adres) → bot doet dit al → geen push.
        if (!isInPerson(ev) && meetingUrl) continue
        const { data: dup } = await sb.from('meeting_push_log').select('id').eq('member_id', m.id).eq('event_id', ev.id).maybeSingle()
        if (dup) { skipped++; continue }
        const evTitle = (ev?.raw?.summary ?? ev?.title ?? 'je meeting').toString().slice(0, 80)
        let status = 'ok'
        try { status = await sendPush(m.expo_push_token, '', evTitle) } catch (e) { status = `err:${(e as Error).message}`.slice(0, 100) }
        await sb.from('meeting_push_log').insert({ member_id: m.id, event_id: ev.id, meeting_start: ev?.start_time ?? null, push_status: status })
        if (status === 'ok') pushed++; else errors++
      }
    } catch { errors++ }
  }
  return json({ ok: true, members: (members ?? []).length, pushed, skipped, errors })
})

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })
}
