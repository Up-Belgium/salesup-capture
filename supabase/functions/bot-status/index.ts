// salesUp Capture — bot-status (READ-ONLY diagnose)
// Haalt de Recall-bot-statusgeschiedenis op voor één of meer bot-ids. Geeft
// ENKEL de lifecycle-codes terug (geen transcript/inhoud) om te zien waarom een
// bot niet opnam: niet binnengelaten (in_waiting_room → call_ended), join-fout
// (fatal), of wel opgenomen (in_call_recording → done). Verandert NIETS.
// Body: { bot_ids: string[] } en/of { calendar_event_ids: string[] } (agenda-bots:
// de bot-id wordt via GET /api/v2/calendar-events/{id}/ opgezocht).
// Per bot ook of er een (streaming-)transcript klaarstaat (ja/nee, geen inhoud).
const recallKey = (Deno.env.get('RECALL_API_KEY') ?? '').trim()
const recallUrl = (Deno.env.get('RECALL_API_URL') ?? 'https://eu-central-1.recall.ai').trim()

Deno.serve(async (req) => {
  if (!recallKey) return j({ error: 'RECALL_API_KEY niet gezet' }, 500)
  let body: any = {}
  try { body = await req.json() } catch { /* */ }
  const ids: string[] = Array.isArray(body?.bot_ids) ? [...body.bot_ids] : (body?.bot_id ? [body.bot_id] : [])
  const evIds: string[] = Array.isArray(body?.calendar_event_ids) ? body.calendar_event_ids.slice(0, 20) : []
  const headers = { Authorization: `Token ${recallKey}`, 'Content-Type': 'application/json' }
  const evMap: Record<string, string> = {}
  for (const ev of evIds) {
    try {
      const r = await fetch(`${recallUrl}/api/v2/calendar-events/${ev}/`, { headers })
      const e = r.ok ? await r.json() : null
      const bots = Array.isArray(e?.bots) ? e.bots : []
      for (const b of bots) if (b?.bot_id) { ids.push(b.bot_id); evMap[b.bot_id] = ev }
      if (bots.length === 0) evMap[`none:${ev}`] = ev
    } catch { /* */ }
  }
  if (ids.length === 0) return j({ ok: true, bots: [], events_without_bot: Object.values(evMap) })

  const out: any[] = []
  for (const id of ids.slice(0, 20)) {
    try {
      const r = await fetch(`${recallUrl}/api/v1/bot/${id}/`, { headers })
      const t = await r.text()
      if (!r.ok) { out.push({ bot_id: id, http: r.status, error: t.slice(0, 200) }); continue }
      const b = JSON.parse(t)
      const changes = Array.isArray(b?.status_changes) ? b.status_changes : []
      const recs = Array.isArray(b?.recordings) ? b.recordings : []
      out.push({
        bot_id: id,
        calendar_event_id: evMap[id] ?? null,
        current: b?.status?.code ?? null,
        meeting_url_present: !!(b?.meeting_url),
        recordings: recs.length,
        transcript_status: recs.map((x: any) => x?.media_shortcuts?.transcript?.status?.code ?? null),
        transcript_ready: recs.some((x: any) => !!x?.media_shortcuts?.transcript?.data?.download_url),
        status_changes: changes.map((c: any) => ({ code: c?.code, sub_code: c?.sub_code ?? null, message: (c?.message ?? '').toString().slice(0, 120), created_at: c?.created_at })),
      })
    } catch (e) {
      out.push({ bot_id: id, error: String(e).slice(0, 200) })
    }
  }
  return j({ ok: true, bots: out, events_without_bot: Object.keys(evMap).filter((k) => k.startsWith('none:')).map((k) => evMap[k]) })
})

function j(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })
}
