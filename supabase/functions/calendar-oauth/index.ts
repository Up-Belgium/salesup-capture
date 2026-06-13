// ============================================================================
// salesUp Capture — calendar-oauth
// ============================================================================
// Enterprise-kalenderkoppeling via Google OAuth (Recall Calendar V2). De
// gebruiker klikt één knop, ziet het standaard Google-toestemmingsscherm en is
// klaar — geen geheime URL, volledig intrekbaar. De OAuth-refreshtoken gaat
// rechtstreeks naar Recall (Recall beheert verversing); wij bewaren enkel de
// Recall-calendar-id op het lid.
//
// Acties:
//   POST { action:'auth_url' }   (Authorization: Bearer <user-JWT>)
//      → { url } : Google-consentscherm; state = signed member_id
//   GET  ?code=…&state=…         (browser-redirect van Google, geen JWT)
//      → wisselt code→refreshtoken, maakt Recall-calendar, slaat id op,
//        toont "Verbonden" HTML
//   POST { action:'disconnect' } (Authorization: Bearer <user-JWT>)
//      → ontkoppelt (recall_calendar_id leegmaken)
//
// Secrets: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
//          RECALL_API_KEY (+ RECALL_API_URL, default eu-central-1),
//          CAPTURE_PUBLIC_FUNCTIONS_URL (default https://<ref>.functions.supabase.co)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly'
const FUNCTIONS_BASE = (Deno.env.get('CAPTURE_PUBLIC_FUNCTIONS_URL')
  ?? `${(Deno.env.get('SUPABASE_URL') ?? '').replace('.supabase.co', '.functions.supabase.co')}`).replace(/\/$/, '')
const REDIRECT_URI = `${FUNCTIONS_BASE}/calendar-oauth`

// ── state-ondertekening (stateless, HMAC met de service-role key) ───────────
async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]!))
}
async function signState(memberId: string): Promise<string> {
  return `${memberId}.${await hmac(memberId)}`
}
async function verifyState(state: string): Promise<string | null> {
  const [memberId, sig] = String(state).split('.')
  if (!memberId || !sig) return null
  return (await hmac(memberId)) === sig ? memberId : null
}

// Supabase's functions-gateway forceert text/plain voor HTML (anti-phishing op
// het gedeelde domein). We serveren daarom een propere UTF-8 platte-tekstpagina
// — die rendert altijd correct en oogt verzorgd i.p.v. kapotte HTML.
function page(opts: { ok: boolean; title: string; body: string }): Response {
  const mark = opts.ok ? '✓' : '✕'
  const text =
`salesUp Capture
────────────────────

${mark}  ${opts.title}

${opts.body}

Je kan dit venster nu sluiten.`
  return new Response(text, {
    status: 200,
    headers: new Headers({ 'content-type': 'text/plain; charset=utf-8' }),
  })
}
function html(title: string, body: string): Response {
  // bestaande aanroepen: titel met "✓" = succes, anders fout
  return page({ ok: /✓|verbonden/i.test(title), title: title.replace(/\s*✓\s*/, ''), body })
}

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const clientId = (Deno.env.get('GOOGLE_OAUTH_CLIENT_ID') ?? '').trim()
  const clientSecret = (Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET') ?? '').trim()

  // ── GET = OAuth-callback van Google ───────────────────────────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state') ?? ''
    if (url.searchParams.get('error')) return html('Koppeling geannuleerd', 'Je kan dit venster sluiten en het later opnieuw proberen.')
    if (!code) return html('Ongeldige aanvraag', 'Geen autorisatiecode ontvangen.')
    const memberId = await verifyState(state)
    if (!memberId) return html('Beveiligingsfout', 'De koppeling kon niet geverifieerd worden. Probeer opnieuw vanuit de app.')

    try {
      // 1 · code → refresh_token bij Google
      const tok = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
        }),
      })
      const tokJson = await tok.json()
      if (!tok.ok || !tokJson.refresh_token) {
        throw new Error(tokJson.error_description || tokJson.error || 'geen refresh_token (consent al eerder gegeven? probeer met prompt=consent)')
      }

      // 2 · Recall-calendar aanmaken met de refreshtoken
      const recallUrl = (Deno.env.get('RECALL_API_URL') ?? 'https://eu-central-1.recall.ai').trim()
      const cal = await fetch(`${recallUrl}/api/v2/calendars/`, {
        method: 'POST',
        headers: { Authorization: `Token ${(Deno.env.get('RECALL_API_KEY') ?? '').trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'google_calendar',
          oauth_client_id: clientId,
          oauth_client_secret: clientSecret,
          oauth_refresh_token: tokJson.refresh_token,
        }),
      })
      const calJson = await cal.json()
      if (!cal.ok || !calJson.id) throw new Error(`Recall ${cal.status}: ${JSON.stringify(calJson).slice(0, 200)}`)

      await sb.from('members').update({
        recall_calendar_id: calJson.id,
        calendar_platform: 'google_calendar',
        calendar_email: calJson.oauth_email ?? null,
        calendar_connected_at: new Date().toISOString(),
      }).eq('id', memberId)

      console.log(`calendar-oauth: verbonden member ${memberId} → calendar ${calJson.id}`)
      return page({
        ok: true,
        title: 'Je agenda is verbonden!',
        body: 'Vanaf nu neemt salesUp Capture je videocall-meetings automatisch op — je hoeft niets meer te doen. Na elke meeting krijg je een samenvatting met actiepunten in je mailbox.',
      })
    } catch (e) {
      console.error(`calendar-oauth callback: ${e}`)
      return html('Koppeling mislukt', String(e).slice(0, 300))
    }
  }

  // ── POST = app-acties (vereisen user-JWT) ─────────────────────────────────
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const { data: au } = await sb.auth.getUser(jwt)
  if (!au?.user?.id) return json({ ok: false, error: 'unauthorized' }, 401)
  const { data: member } = await sb.from('members')
    .select('id').eq('user_id', au.user.id).eq('is_active', true).maybeSingle()
  if (!member?.id) return json({ ok: false, error: 'geen actief lid' }, 403)

  let body: any = {}
  try { body = await req.json() } catch { /* leeg */ }

  if (body?.action === 'auth_url') {
    if (!clientId) return json({ ok: false, error: 'GOOGLE_OAUTH_CLIENT_ID niet gezet als Edge Function secret' }, 500)
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    u.searchParams.set('client_id', clientId)
    u.searchParams.set('redirect_uri', REDIRECT_URI)
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('scope', SCOPE)
    u.searchParams.set('access_type', 'offline')
    u.searchParams.set('prompt', 'consent')
    u.searchParams.set('state', await signState(member.id))
    return json({ ok: true, url: u.toString() })
  }

  if (body?.action === 'disconnect') {
    await sb.from('members').update({
      recall_calendar_id: null, calendar_platform: null, calendar_email: null, calendar_connected_at: null,
    }).eq('id', member.id)
    return json({ ok: true })
  }

  if (body?.action === 'status') {
    const { data: m } = await sb.from('members')
      .select('calendar_platform, calendar_email, calendar_connected_at').eq('id', member.id).maybeSingle()
    return json({ ok: true, connected: !!m?.calendar_connected_at, ...m })
  }

  return json({ ok: false, error: "action moet 'auth_url', 'status' of 'disconnect' zijn" }, 400)
})

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
    },
  })
}
