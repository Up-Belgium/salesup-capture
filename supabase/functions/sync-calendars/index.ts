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
// Annulatie: is een agenda-event verwijderd (ev.is_deleted) én is de bijhorende
// opname nog niet gestart (pending_upload, geen storage_path), dan zetten we die
// op 'cancelled' (verdwijnt uit de opnamelijst) en annuleren we de bot. Reeds
// opgenomen/getranscribeerde meetings blijven onaangeroerd. Verschuift een
// meeting (nieuwe start_time) dan werken we started_at bij; wordt een eerder
// geannuleerd event terug actief, dan plannen we opnieuw.
// Secrets: RECALL_API_KEY (+ RECALL_API_URL, default eu-central-1)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// cron-guard: zie transcribe-recordings. FAIL-OPEN tot CRON_SECRET gezet is.
function cronForbidden(req: Request): Response | null {
  const expected = (Deno.env.get('CRON_SECRET') ?? '').trim()
  if (!expected) return null
  const got = (req.headers.get('x-cron-secret') ?? '').trim()
  if (got === expected) return null
  return new Response(JSON.stringify({ error: 'forbidden (cron-secret)' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
}

// Ruim plannen i.p.v. een krap venster: Recall laat de bot vanzelf op de
// starttijd binnenkomen. Zo missen we geen meetings waarvan de link laat synct
// of waarvan een cron-tik het krappe venster net miste. Dedup via
// recordings.calendar_event_uid voorkomt dubbele bots.
const WINDOW_BEFORE_MIN = 120        // ook lopende meetings (tot 2u geleden gestart)
const WINDOW_AHEAD_MIN = 24 * 60     // alle meetings tot 24u vooruit
// Bot mag tot 60 min in de wachtruimte staan (Recall-default is 20 min).
// Extern gehoste meetings laten de bot vaak pas laat of niet meteen toe —
// dit was dé hoofdoorzaak van gemiste opnames (timeout_exceeded_waiting_room).
const WAITING_ROOM_TIMEOUT_S = 3600
// GDPR: Recall bewaart opnames (audio/video/transcript) zonder instelling ONBEPERKT
// (accounts na 12/6/2025). poll-bots haalt het transcript binnen 24u na de start
// op; daarna heeft Recall de media niet meer nodig → na 72u automatisch gewist.
const RECALL_RETENTION_HOURS = 72

function platformOf(url: string): string {
  return /meet\.google/.test(url) ? 'google_meet'
       : /zoom\./.test(url) ? 'zoom'
       : /teams\./.test(url) ? 'teams'
       : /webex\./.test(url) ? 'webex' : 'other'
}

// Klantgesprek? = een ZAKELIJKE externe partij is betrokken — ofwel als
// deelnemer, ofwel als ORGANISATOR. De organisator-check is cruciaal voor
// extern-georganiseerde meetings: Google deelt dan de gastenlijst vaak niet met
// genodigden, waardoor attendees leeg of enkel het eigen domein lijkt. Zo slaan
// we nog steeds over: interne meetings (alle deelnemers + organisator binnen
// eigen domein), persoonlijke agenda-items zonder externe partij, en
// persoonlijke afspraken met enkel een vrije-mail-domein (gmail/hotmail/...).
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.be', 'hotmail.fr', 'hotmail.nl',
  'outlook.com', 'outlook.be', 'outlook.fr', 'live.com', 'live.be', 'live.nl',
  'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'yahoo.fr', 'yahoo.co.uk',
  'msn.com', 'aol.com', 'gmx.com', 'gmx.net', 'protonmail.com', 'proton.me',
  'telenet.be', 'skynet.be', 'proximus.be', 'scarlet.be', 'pandora.be',
])
// Agenda-systeemadressen (vergaderzalen, gedeelde agenda's) zijn geen echte
// externe partij — negeren.
function isSystemAddress(email: string): boolean {
  return email.endsWith('resource.calendar.google.com') || email.endsWith('group.calendar.google.com') || email.endsWith('calendar.google.com')
}
function businessDomainExternal(email: string | null, ownDomain: string | null): boolean {
  if (!email || !email.includes('@')) return false
  if (isSystemAddress(email)) return false
  const d = email.split('@')[1]
  if (!d) return false
  return d !== ownDomain && !FREE_MAIL_DOMAINS.has(d)
}
function attendeeEmails(ev: any): string[] {
  const raw = ev?.raw ?? {}
  const list = Array.isArray(raw.attendees) ? raw.attendees : []
  const out: string[] = []
  for (const a of list) {
    if (a?.resource) continue // vergaderzaal/resource overslaan
    const email = (a?.email ?? a?.emailAddress?.address ?? '').toString().toLowerCase().trim()
    if (email && email.includes('@') && !email.endsWith('resource.calendar.google.com')) out.push(email)
  }
  return out
}
// Organisator/aanmaker van het event (Google: organizer.email / creator.email,
// Microsoft: organizer.emailAddress.address).
function organizerEmail(ev: any): string | null {
  const raw = ev?.raw ?? {}
  const e = (raw.organizer?.email ?? raw.organizer?.emailAddress?.address ?? raw.creator?.email ?? '')
    .toString().toLowerCase().trim()
  return e && e.includes('@') ? e : null
}
function isExternalMeeting(ev: any, ownDomain: string | null): boolean {
  // 1. Organisator is een zakelijke externe partij? → klantgesprek, ook al is de
  //    gastenlijst verborgen (typisch bij extern-georganiseerde meetings).
  if (businessDomainExternal(organizerEmail(ev), ownDomain)) return true
  // 2. Anders: minstens één zakelijke externe DEELNEMER.
  const emails = attendeeEmails(ev)
  if (emails.length === 0) return false              // geen deelnemers én geen externe organisator → persoonlijk/intern
  return emails.some((e) => businessDomainExternal(e, ownDomain))
}

// Fysieke locatie? = een echt adres in het event, geen (video)link. Google geeft
// raw.location (string), Microsoft raw.location.displayName. Zo'n event is een
// face-to-face afspraak → géén bot (ook al voegde de agenda automatisch een
// Meet-link toe); notify-meetings stuurt er een opname-herinnering voor.
function eventLocation(ev: any): string {
  const raw = ev?.raw ?? {}
  const loc = (typeof raw.location === 'string' ? raw.location : (raw.location?.displayName ?? '')).toString().trim()
  return loc
}
// Outlook/Teams vult de locatie automatisch met een label als "Microsoft Teams-
// vergadering" / "Microsoft Teams Meeting" (Zoom/Meet/Webex idem). Zo'n label
// zonder cijfers is GEEN adres → videocall, geen fysieke afspraak. Een echt adres
// bevat (bijna) altijd cijfers (huisnummer/postcode), ook als er een Meet-
// hardware-zaal bij vermeld staat.
function isVirtualLabel(loc: string): boolean {
  return !/\d/.test(loc) && /\b(teams|zoom|google meet|webex|skype|whereby|gotomeeting)\b/i.test(loc)
}
function isInPerson(ev: any): boolean {
  const loc = eventLocation(ev)
  if (!loc) return false
  if (/^https?:\/\//i.test(loc)) return false               // locatie is een URL → niet fysiek
  if (/(meet\.google|zoom\.|teams\.|webex\.)/i.test(loc)) return false
  if (isVirtualLabel(loc)) return false                      // "Microsoft Teams-vergadering" e.d.
  return true
}

// Branded cover (1280x720 JPEG) die de bot in de meeting toont — uit de
// publieke assets-bucket, éénmalig per run base64-gecodeerd.
function toB64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(s)
}
async function loadCover(): Promise<string | null> {
  try {
    const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/assets/bot_cover.jpg`
    const r = await fetch(url)
    if (!r.ok) return null
    return toB64(new Uint8Array(await r.arrayBuffer()))
  } catch { return null }
}

// Statussen waarin een opname nog NIET is vastgelegd — enkel die mogen we bij
// annulatie/verschuiving nog aanraken. uploaded/transcribing/transcribed/error
// betekenen dat de meeting effectief plaatsvond → nooit overschrijven.
const NOT_YET_RECORDED = new Set(['pending_upload'])

// Plant (of herplant) de Recall-bot voor een event. Gooit bij een niet-OK-status.
async function scheduleBot(recallUrl: string, recallHeaders: Record<string, string>, evId: string, coverB64: string | null): Promise<void> {
  const botRes = await fetch(`${recallUrl}/api/v2/calendar-events/${evId}/bot/`, {
    method: 'POST',
    headers: recallHeaders,
    body: JSON.stringify({
      deduplication_key: `salesup-${evId}`,
      bot_config: {
        bot_name: 'salesUp Capture',
        // Wachtruimte-tolerantie omhoog (default 20 min → 60 min): dé
        // hoofdoorzaak van gemiste opnames bij extern gehoste meetings.
        automatic_leave: { waiting_room_timeout: WAITING_ROOM_TIMEOUT_S },
        ...(coverB64 ? { automatic_video_output: { in_call_recording: { kind: 'jpeg', b64_data: coverB64 } } } : {}),
        recording_config: {
          // Deepgram nova-3 met language:'multi' → echte code-switching over o.a.
          // NL én FR in één meeting (Recall's eigen ASR fragmenteerde de niet-
          // dominante taal). Vereist een gekoppelde Deepgram-key in Recall.
          // mip_opt_out: Deepgram bewaart de audio niet voor modelverbetering.
          // (EU-verwerking bij Deepgram = host api.eu.deepgram.com in de
          // Deepgram-instelling van het Recall-dashboard.)
          transcript: { provider: { deepgram_streaming: { model: 'nova-3', language: 'multi', mip_opt_out: true } } },
          retention: { type: 'timed', hours: RECALL_RETENTION_HOURS },
        },
      },
    }),
  })
  if (!botRes.ok) throw new Error(`schedule-bot ${botRes.status}: ${(await botRes.text()).slice(0, 150)}`)
  await botRes.json().catch(() => ({}))
}

Deno.serve(async (req) => {
  const denied = cronForbidden(req); if (denied) return denied
  const recallKey = (Deno.env.get('RECALL_API_KEY') ?? '').trim()
  if (!recallKey) return json({ ok: false, error: 'RECALL_API_KEY niet gezet als Edge Function secret' }, 500)
  const recallUrl = (Deno.env.get('RECALL_API_URL') ?? 'https://eu-central-1.recall.ai').trim()
  const recallHeaders = { Authorization: `Token ${recallKey}`, 'Content-Type': 'application/json' }

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: membersList } = await sb.from('members')
    .select('id, org_id, full_name, email, calendar_email, recall_calendar_id')
    .not('recall_calendar_id', 'is', null)
    .eq('is_active', true)

  let dbg: any = null
  try { dbg = (await req.clone().json())?.debug ? true : null } catch { /* */ }

  // Diagnose-modus: privacyveilig (geen titels/inhoud) — toont of events met
  // videocall-link binnenkomen, hoe ze geclassificeerd worden en geplande bots.
  if (dbg) {
    const out: any[] = []
    const gte = new Date(Date.now() - 12 * 3600_000).toISOString()
    const lte = new Date(Date.now() + 24 * 3600_000).toISOString()
    for (const m of membersList ?? []) {
      const ownDomain = String(m.calendar_email ?? m.email ?? '').toLowerCase().split('@')[1] ?? null
      const r = await fetch(`${recallUrl}/api/v2/calendar-events/?calendar_id=${m.recall_calendar_id}&start_time__gte=${gte}&start_time__lte=${lte}`, { headers: recallHeaders })
      const j = await r.json().catch(() => ({}))
      const evs = Array.isArray(j?.results) ? j.results : (Array.isArray(j) ? j : [])
      out.push({
        member: m.full_name,
        http: r.status, event_count: evs.length,
        events: evs.slice(0, 12).map((e: any) => ({
          start_time: e?.start_time,
          is_deleted: !!e?.is_deleted,
          has_meeting_url: !!(e?.meeting_url ?? e?.meeting_platform_url),
          location: eventLocation(e),
          in_person: isInPerson(e),
          external: isExternalMeeting(e, ownDomain),
          organizer_external: businessDomainExternal(organizerEmail(e), ownDomain),
          bots: e?.bots ?? null,
        })),
      })
    }
    return json({ ok: true, debug: out })
  }

  const now = Date.now()
  const gte = new Date(now - WINDOW_BEFORE_MIN * 60_000).toISOString()
  const lte = new Date(now + WINDOW_AHEAD_MIN * 60_000).toISOString()
  const coverB64 = await loadCover()

  let scheduled = 0, skipped = 0, errors = 0, internal = 0, inPerson = 0, cancelled = 0, rescheduled = 0, reactivated = 0
  let lastErrorCode: string | null = null  // generieke hint (bv. 402 credit) zonder details te lekken
  for (const m of membersList ?? []) {
    try {
      const ownDomain = String(m.calendar_email ?? m.email ?? '').toLowerCase().split('@')[1] ?? null
      const evRes = await fetch(
        `${recallUrl}/api/v2/calendar-events/?calendar_id=${m.recall_calendar_id}&start_time__gte=${gte}&start_time__lte=${lte}`,
        { headers: recallHeaders },
      )
      if (!evRes.ok) throw new Error(`list-events ${evRes.status}: ${(await evRes.text()).slice(0, 150)}`)
      const evJson = await evRes.json()
      const events = Array.isArray(evJson?.results) ? evJson.results : (Array.isArray(evJson) ? evJson : [])

      for (const ev of events) {
        // Per-event afgeschermd: één mislukt event mag de rest niet blokkeren.
        try {
          // Bestaande opname voor dit agenda-event (indien al gepland).
          const { data: existing } = await sb.from('recordings')
            .select('id, status, storage_path, started_at')
            .eq('member_id', m.id).eq('calendar_event_uid', ev.id).maybeSingle()

          // --- Annulatie: event verwijderd in agenda ---
          if (ev?.is_deleted) {
            // Enkel een nog-niet-opgenomen opname verbergen; reeds opgenomen
            // meetings (uploaded/transcribing/transcribed/error) blijven staan.
            if (existing && !existing.storage_path && NOT_YET_RECORDED.has(existing.status)) {
              // Bot best-effort annuleren (Recall ruimt bij event-delete meestal
              // zelf op; DELETE is enkel een vangnet).
              await fetch(`${recallUrl}/api/v2/calendar-events/${ev.id}/bot/`, { method: 'DELETE', headers: recallHeaders }).catch(() => {})
              await sb.from('recordings').update({
                status: 'cancelled',
                cancelled_at: new Date().toISOString(),
                error: 'Meeting geannuleerd in agenda',
                updated_at: new Date().toISOString(),
              }).eq('id', existing.id)
              cancelled++
              console.log(`sync-calendars: opname geannuleerd voor event ${ev.id} (${m.full_name})`)
            }
            continue
          }

          const meetingUrl: string | null = ev?.meeting_url ?? ev?.meeting_platform_url ?? null
          if (!meetingUrl || !meetingUrl.startsWith('http')) continue
          // Al afgelopen meetings overslaan — daar kan geen bot meer voor joinen.
          const endMs = ev?.end_time ? new Date(ev.end_time).getTime() : null
          if (endMs && endMs < now) continue
          // Fysieke afspraak (echt adres) → geen bot, ook al hangt er een Meet-link aan;
          // notify-meetings stuurt hiervoor een opname-herinnering naar de telefoon.
          if (isInPerson(ev)) { inPerson++; continue }
          // Geen zakelijke externe partij (deelnemer óf organisator) → intern/persoonlijk → overslaan.
          if (!isExternalMeeting(ev, ownDomain)) { internal++; continue }

          // --- Reactivatie: eerder geannuleerd, maar event staat weer actief ---
          if (existing && existing.status === 'cancelled') {
            await scheduleBot(recallUrl, recallHeaders, ev.id, coverB64)
            await sb.from('recordings').update({
              status: 'pending_upload',
              cancelled_at: null,
              error: null,
              started_at: ev?.start_time ?? existing.started_at,
              updated_at: new Date().toISOString(),
            }).eq('id', existing.id)
            reactivated++
            console.log(`sync-calendars: opname heropend voor event ${ev.id} (${m.full_name})`)
            continue
          }

          if (existing) {
            // Verschuiving: starttijd gewijzigd → started_at bijwerken (enkel als
            // de opname nog niet is vastgelegd). Bot volgt het event vanzelf.
            // Vergelijk op tijdstip (epoch), niet op tekst: de DB bewaart
            // timestamptz ("...+00") terwijl Recall ISO ("...Z") stuurt — een
            // string-vergelijking zou élke run een nutteloze update triggeren.
            const evStartMs = ev?.start_time ? new Date(ev.start_time).getTime() : NaN
            const curStartMs = existing.started_at ? new Date(existing.started_at).getTime() : NaN
            if (!existing.storage_path && NOT_YET_RECORDED.has(existing.status) &&
                Number.isFinite(evStartMs) && Number.isFinite(curStartMs) &&
                Math.abs(evStartMs - curStartMs) > 60_000) {
              await sb.from('recordings').update({
                started_at: ev.start_time,
                updated_at: new Date().toISOString(),
              }).eq('id', existing.id)
              rescheduled++
            }
            skipped++; continue
          }

          await scheduleBot(recallUrl, recallHeaders, ev.id, coverB64)

          const { data: rec, error } = await sb.from('recordings').insert({
            org_id:             m.org_id,
            member_id:          m.id,
            recording_type:     'video_meeting',
            meeting_platform:   platformOf(meetingUrl),
            title:              ev?.raw?.summary ?? ev?.title ?? null,
            started_at:         ev?.start_time ?? new Date().toISOString(),
            external_ref:       `calevent:${ev.id}`,
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
        } catch (evErr) {
          errors++
          const msg = String(evErr)
          if (/402|insufficient_credit/i.test(msg)) lastErrorCode = 'recall_insufficient_credit'
          console.error(`sync-calendars: event ${ev?.id} (${m.full_name}): ${evErr}`)
        }
      }
    } catch (e) {
      errors++
      console.error(`sync-calendars: lid ${m.id}: ${e}`)
    }
  }

  console.log(`sync-calendars: leden=${(membersList ?? []).length} gepland=${scheduled} dedupe=${skipped} geannuleerd=${cancelled} verschoven=${rescheduled} heropend=${reactivated} intern=${internal} fysiek=${inPerson} fouten=${errors}`)

  // Krediet-alarm: bij Recall 402 (insufficient_credit) vielen meetings vroeger
  // STILLETJES weg (de cron leest niemand). We mailen nu de owner(s) zodat dit
  // nooit meer ongemerkt gebeurt. Throttle in alertOwners() voorkomt spam.
  if (lastErrorCode === 'recall_insufficient_credit') {
    try { await alertOwners(sb) } catch (e) { console.error(`sync-calendars: krediet-alarm faalde: ${e}`) }
  }

  return json({ ok: true, members: (membersList ?? []).length, scheduled, skipped, cancelled, rescheduled, reactivated, internal, in_person: inPerson, errors, hint: lastErrorCode })
})

// Mailt actieve owners dat het Recall-krediet op is. Graceful skip zonder
// RESEND_API_KEY. Throttle: enkel in de eerste 5 min van het uur, zodat de
// 5-minuten-cron hooguit ~1 mail per uur stuurt tijdens een outage.
async function alertOwners(sb: any): Promise<void> {
  const resendKey = (Deno.env.get('RESEND_API_KEY') ?? '').trim()
  if (!resendKey) return
  if (new Date().getMinutes() >= 5) return
  const from = (Deno.env.get('CAPTURE_EMAIL_FROM') ?? 'salesUp Capture <capture@salesup.be>').trim()
  const { data: owners } = await sb.from('members')
    .select('email').eq('role', 'owner').eq('is_active', true)
  const to = [...new Set((owners ?? []).map((o: any) => (o.email ?? '').trim()).filter(Boolean))]
  if (to.length === 0) return
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to,
      subject: '⚠️ salesUp Capture: Recall-krediet op — meetings worden niet opgenomen',
      text: [
        'Let op: bij het inplannen van opname-bots gaf Recall "insufficient_credit" (402).',
        'Zolang dit aanhoudt worden ingeplande meetings NIET opgenomen.',
        '',
        'Actie: vul het krediet aan in je Recall-account. Het systeem hervat dan',
        'automatisch bij de volgende synchronisatie (elke 5 minuten).',
        '',
        '— salesUp Capture',
      ].join('\n'),
    }),
  })
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
