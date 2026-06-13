// ============================================================================
// salesUp Capture — calendar-oauth  (Google Agenda + Microsoft Outlook)
// ============================================================================
// Kalenderkoppeling via OAuth (Recall Calendar V2). Eén knop, standaard
// toestemmingsscherm van Google óf Microsoft, refresh-token gaat naar Recall.
//
// Acties (POST, Bearer user-JWT):
//   { action:'auth_url', provider?:'google'|'microsoft' } → { url }
//   { action:'status' }   → verbindingsstatus van het lid
//   { action:'disconnect' }
// GET ?code=…&state=…  = OAuth-callback (geen JWT; state is HMAC-ondertekend)
//
// Secrets: GOOGLE_OAUTH_CLIENT_ID/SECRET, MS_OAUTH_CLIENT_ID/SECRET,
//          RECALL_API_KEY (+ RECALL_API_URL), CAPTURE_PUBLIC_FUNCTIONS_URL
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const FUNCTIONS_BASE = (Deno.env.get('CAPTURE_PUBLIC_FUNCTIONS_URL')
  ?? `${(Deno.env.get('SUPABASE_URL') ?? '').replace('.supabase.co', '.functions.supabase.co')}`).replace(/\/$/, '')
const REDIRECT_URI = `${FUNCTIONS_BASE}/calendar-oauth`

interface Provider {
  authUrl: string; tokenUrl: string; scope: string; recallPlatform: string
  clientId(): string; clientSecret(): string
}
const PROVIDERS: Record<string, Provider> = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/calendar.events.readonly',
    recallPlatform: 'google_calendar',
    clientId: () => (Deno.env.get('GOOGLE_OAUTH_CLIENT_ID') ?? '').trim(),
    clientSecret: () => (Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET') ?? '').trim(),
  },
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access openid email Calendars.Read',
    recallPlatform: 'microsoft_outlook',
    clientId: () => (Deno.env.get('MS_OAUTH_CLIENT_ID') ?? '').trim(),
    clientSecret: () => (Deno.env.get('MS_OAUTH_CLIENT_SECRET') ?? '').trim(),
  },
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]!))
}
async function signState(memberId: string, provider: string): Promise<string> {
  return `${memberId}.${provider}.${await hmac(`${memberId}.${provider}`)}`
}
async function verifyState(state: string): Promise<{ memberId: string; provider: string } | null> {
  const [memberId, provider, sig] = String(state).split('.')
  if (!memberId || !provider || !sig) return null
  return (await hmac(`${memberId}.${provider}`)) === sig ? { memberId, provider } : null
}

function page(opts: { ok: boolean; title: string; body: string }): Response {
  const mark = opts.ok ? '✓' : '✕'
  const text = `salesUp Capture\n────────────────────\n\n${mark}  ${opts.title}\n\n${opts.body}\n\nJe kan dit venster nu sluiten.`
  return new Response(text, { status: 200, headers: new Headers({ 'content-type': 'text/plain; charset=utf-8' }) })
}

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // ── GET = OAuth-callback ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url)
    if (url.searchParams.get('error')) return page({ ok: false, title: 'Koppeling geannuleerd', body: 'Je kan dit later opnieuw proberen vanuit de app.' })
    const code = url.searchParams.get('code')
    if (!code) return page({ ok: false, title: 'Ongeldige aanvraag', body: 'Geen autorisatiecode ontvangen.' })
    const st = await verifyState(url.searchParams.get('state') ?? '')
    if (!st) return page({ ok: false, title: 'Beveiligingsfout', body: 'Kon de koppeling niet verifiëren. Probeer opnieuw vanuit de app.' })
    const prov = PROVIDERS[st.provider]
    if (!prov) return page({ ok: false, title: 'Onbekende provider', body: st.provider })

    try {
      const tok = await fetch(prov.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: prov.clientId(), client_secret: prov.clientSecret(),
          redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
          ...(st.provider === 'microsoft' ? { scope: prov.scope } : {}),
        }),
      })
      const tokJson = await tok.json()
      if (!tok.ok || !tokJson.refresh_token) {
        throw new Error(tokJson.error_description || tokJson.error || 'geen refresh_token ontvangen')
      }

      const recallUrl = (Deno.env.get('RECALL_API_URL') ?? 'https://eu-central-1.recall.ai').trim()
      const cal = await fetch(`${recallUrl}/api/v2/calendars/`, {
        method: 'POST',
        headers: { Authorization: `Token ${(Deno.env.get('RECALL_API_KEY') ?? '').trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: prov.recallPlatform,
          oauth_client_id: prov.clientId(),
          oauth_client_secret: prov.clientSecret(),
          oauth_refresh_token: tokJson.refresh_token,
        }),
      })
      const calJson = await cal.json()
      if (!cal.ok || !calJson.id) throw new Error(`Recall ${cal.status}: ${JSON.stringify(calJson).slice(0, 200)}`)

      await sb.from('members').update({
        recall_calendar_id: calJson.id,
        calendar_platform: prov.recallPlatform,
        calendar_email: calJson.oauth_email ?? null,
        calendar_connected_at: new Date().toISOString(),
      }).eq('id', st.memberId)

      console.log(`calendar-oauth: ${st.provider} verbonden member ${st.memberId} → ${calJson.id}`)
      return page({
        ok: true,
        title: 'Je agenda is verbonden!',
        body: 'Vanaf nu neemt salesUp Capture je videocall-meetings automatisch op. Na elke meeting krijg je een samenvatting met actiepunten in je mailbox.',
      })
    } catch (e) {
      console.error(`calendar-oauth callback: ${e}`)
      return page({ ok: false, title: 'Koppeling mislukt', body: String(e).slice(0, 300) })
    }
  }

  // ── POST = app-acties (user-JWT) ──────────────────────────────────────────
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const { data: au } = await sb.auth.getUser(jwt)
  if (!au?.user?.id) return json({ ok: false, error: 'unauthorized' }, 401)
  const { data: member } = await sb.from('members')
    .select('id').eq('user_id', au.user.id).eq('is_active', true).maybeSingle()
  if (!member?.id) return json({ ok: false, error: 'geen actief lid' }, 403)

  let body: any = {}
  try { body = await req.json() } catch { /* leeg */ }

  if (body?.action === 'auth_url') {
    const providerKey = body.provider === 'microsoft' ? 'microsoft' : 'google'
    const prov = PROVIDERS[providerKey]
    if (!prov.clientId()) return json({ ok: false, error: `${providerKey === 'microsoft' ? 'MS' : 'GOOGLE'}_OAUTH_CLIENT_ID niet gezet als Edge Function secret` }, 500)
    const u = new URL(prov.authUrl)
    u.searchParams.set('client_id', prov.clientId())
    u.searchParams.set('redirect_uri', REDIRECT_URI)
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('scope', prov.scope)
    u.searchParams.set('access_type', 'offline')
    u.searchParams.set('prompt', 'consent')
    u.searchParams.set('state', await signState(member.id, providerKey))
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
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' },
  })
}
