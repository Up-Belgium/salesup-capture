// ============================================================================
// salesUp Capture — invite-members
// ============================================================================
// Invite-only uitrol, bulk-capable. Alleen salesUp/eigenaar nodigt uit; zonder
// een door ons aangemaakte member-rij kan niemand de apps gebruiken.
//
// Auth (één van beide):
//   - Header  X-Admin-Secret: <CAPTURE_ADMIN_SECRET>   (salesUp centraal, elke org)
//   - Bearer  <user-JWT> van een owner/admin van de doel-org
//
// POST { org_id, role?, emails: ["a@x.be","b@y.be", ...] }
//   → maakt per e-mail een auth-user (indien nieuw) + member-rij, en mailt een
//     branded "stel je wachtwoord in"-link (Supabase recovery). Geen wachtwoord
//     in de mail. Idempotent: bestaande leden worden overgeslagen/gereactiveerd.
//
// Secrets: CAPTURE_ADMIN_SECRET, RESEND_API_KEY, CAPTURE_EMAIL_FROM?
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ROLES = ['member', 'admin', 'owner']

function inviteEmailHtml(orgName: string, link: string): string {
  return `
  <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;color:#1a2540">
    <div style="background:#1a2540;padding:18px 24px;border-radius:12px 12px 0 0">
      <span style="color:#fff;font-size:18px;font-weight:700">sales<span style="color:#FF6B35">Up</span> Capture</span>
    </div>
    <div style="border:1px solid #e7eaf0;border-top:none;border-radius:0 0 12px 12px;padding:24px">
      <h2 style="margin:0 0 8px">Welkom bij salesUp Capture</h2>
      <p style="line-height:1.55;color:#44506a">Je bent toegevoegd aan <strong>${esc(orgName)}</strong>. salesUp Capture
      maakt automatisch een verslag (samenvatting + actiepunten) van je videocalls en meetings.</p>
      <p style="line-height:1.55;color:#44506a">Stel hieronder je wachtwoord in; daarna log je in de app in met je e-mailadres.</p>
      <p style="text-align:center;margin:24px 0">
        <a href="${link}" style="background:#FF6B35;color:#fff;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:600;display:inline-block">Wachtwoord instellen</a>
      </p>
      <p style="font-size:12px;color:#9aa1b2">Deze link is persoonlijk en verloopt na enige tijd. Heb je dit niet aangevraagd? Negeer deze mail.</p>
    </div>
  </div>`
}
function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'POST vereist' }, 405)

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  let body: any = {}
  try { body = await req.json() } catch { return json({ ok: false, error: 'JSON-body vereist' }, 400) }

  const orgId = body.org_id
  const role = ROLES.includes(body.role) ? body.role : 'member'
  // no_email=true: geen wachtwoord-mail sturen. Gebruikt door het trainingsplatform,
  // waar het wachtwoord via de training-login naar Capture wordt gespiegeld
  // (één wachtwoord). De member + auth-user worden wél aangemaakt.
  const skipEmail = body.no_email === true

  // Ondersteunt twee vormen (backwards-compatible):
  //   { emails: ["a@x.be", ...] }
  //   { members: [{ email, full_name?, training_participant_id? }, ...] }
  const rawList: any[] = Array.isArray(body.members)
    ? body.members
    : Array.isArray(body.emails)
      ? body.emails.map((e: any) => ({ email: e }))
      : []
  const byEmail = new Map<string, { email: string; full_name: string | null; training_participant_id: string | null }>()
  for (const r of rawList) {
    const email = String(r?.email ?? '').trim().toLowerCase()
    if (!/\S+@\S+\.\S+/.test(email)) continue
    byEmail.set(email, {
      email,
      full_name: r?.full_name ? String(r.full_name).trim() : null,
      training_participant_id: r?.training_participant_id ?? null,
    })
  }
  const entries = [...byEmail.values()]
  if (!orgId) return json({ ok: false, error: 'org_id verplicht' }, 400)
  if (entries.length === 0) return json({ ok: false, error: 'geen geldige e-mailadressen' }, 400)
  if (entries.length > 500) return json({ ok: false, error: 'maximaal 500 per oproep' }, 400)

  // ── Autorisatie ───────────────────────────────────────────────────────────
  const adminSecret = (Deno.env.get('CAPTURE_ADMIN_SECRET') ?? '').trim()
  const viaSecret = adminSecret && (req.headers.get('x-admin-secret') ?? '') === adminSecret
  if (!viaSecret) {
    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    const { data: au } = await sb.auth.getUser(jwt)
    if (!au?.user?.id) return json({ ok: false, error: 'unauthorized' }, 401)
    const { data: caller } = await sb.from('members')
      .select('role').eq('user_id', au.user.id).eq('org_id', orgId).eq('is_active', true).maybeSingle()
    if (!caller || !['owner', 'admin'].includes(caller.role)) {
      return json({ ok: false, error: 'alleen een owner/admin van deze organisatie mag uitnodigen' }, 403)
    }
  }

  const { data: org } = await sb.from('organizations').select('name').eq('id', orgId).maybeSingle()
  if (!org) return json({ ok: false, error: 'organisatie niet gevonden' }, 404)

  const resendKey = (Deno.env.get('RESEND_API_KEY') ?? '').trim()
  const from = (Deno.env.get('CAPTURE_EMAIL_FROM') ?? 'salesUp Capture <capture@salesup.be>').trim()

  let invited = 0, reactivated = 0, failed = 0
  const errors: Record<string, string> = {}

  for (const entry of entries) {
    const email = entry.email
    try {
      // 1 · user aanmaken (of bestaande ophalen)
      let userId: string | null = null
      const created = await sb.auth.admin.createUser({ email, email_confirm: true })
      if (created.data?.user?.id) {
        userId = created.data.user.id
      } else {
        // bestaat al → id opzoeken via recovery-link generatie
        const gl = await sb.auth.admin.generateLink({ type: 'recovery', email })
        userId = gl.data?.user?.id ?? null
        if (!userId) throw new Error(created.error?.message || 'kon gebruiker niet aanmaken/vinden')
      }

      // 2 · member-rij (idempotent). full_name/training_participant_id worden
      //     gezet bij aanmaak en bij-gevuld als ze nog ontbreken (re-invite).
      const { data: existingMember } = await sb.from('members')
        .select('id, is_active, full_name, training_participant_id')
        .eq('org_id', orgId).eq('user_id', userId).maybeSingle()
      if (existingMember) {
        const patch: Record<string, unknown> = {}
        if (!existingMember.is_active) { patch.is_active = true; reactivated++ }
        if (entry.full_name && !existingMember.full_name) patch.full_name = entry.full_name
        if (entry.training_participant_id && !existingMember.training_participant_id) {
          patch.training_participant_id = entry.training_participant_id
        }
        if (Object.keys(patch).length) await sb.from('members').update(patch).eq('id', existingMember.id)
      } else {
        await sb.from('members').insert({
          org_id: orgId, user_id: userId, email, role,
          full_name: entry.full_name,
          training_participant_id: entry.training_participant_id,
        })
        invited++
      }

      // 3 · branded "stel je wachtwoord in"-link mailen (tenzij no_email)
      const link = skipEmail ? null : await sb.auth.admin.generateLink({ type: 'recovery', email })
      const actionLink = link?.data?.properties?.action_link
      if (!skipEmail && resendKey && actionLink) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from, to: [email],
            subject: `Welkom bij salesUp Capture — ${org.name}`,
            html: inviteEmailHtml(org.name, actionLink),
          }),
        })
      }
    } catch (e) {
      failed++
      errors[email] = String(e).slice(0, 160)
    }
  }

  console.log(`invite-members: org=${orgId} invited=${invited} reactivated=${reactivated} failed=${failed}`)
  return json({ ok: true, invited, reactivated, failed, total: entries.length, errors })
})

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-admin-secret' },
  })
}
