// ============================================================================
// salesUp Capture — sweep-pending-uploads
// ============================================================================
// Vangnet voor mislukte uploads vanuit de mobiele app (incident 2026-09-28: een
// opname van 75 min bleef op pending_upload staan zonder bestand in storage →
// geen transcript, geen verslag, en niemand wist het).
//
// Per run (cron: elk uur):
//   Opnames met status 'pending_upload', type in_person/phone, ouder dan 2 uur
//   en ZONDER audiobestand op storage_path:
//     - jonger dan 7 dagen en nog geen herinnering → mail naar het lid (Resend,
//       zelfde mechanisme als summarize-email) + upload_reminder_sent_at zetten.
//       De opname staat normaal nog in de Capture-app op het toestel waarmee
//       werd opgenomen en kan daar opnieuw verstuurd worden.
//     - ouder dan 7 dagen → status 'error' (opgegeven), geen mail meer.
//   Opnames waarvan het bestand WEL al in storage staat (upload gelukt, maar de
//   app kwam niet meer tot 'complete') laten we met rust: de wachtrij in de app
//   rondt die af bij de volgende opstart. Consent zetten we hier bewust niet
//   server-side.
//
// Modi:  POST {} (batch, default 50) | { limit } | { dry_run: true } (niets mailen
//        of wijzigen, enkel tonen wat er zou gebeuren)
// Secrets: RESEND_API_KEY · CAPTURE_EMAIL_FROM (default capture@salesup.be)
//          CRON_SECRET (optioneel, fail-open — zie transcribe-recordings)
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

const BUCKET = 'recordings'
const MIN_AGE_H = 2        // pas na 2 uur herinneren (app krijgt eerst zelf de kans)
const GIVE_UP_DAYS = 7     // daarna opgeven → status 'error'
const GIVE_UP_ERROR = 'opname nooit ontvangen (upload mislukt op toestel)'

// Bestaat er een object op dit pad? (storage list op de map + exacte naam)
async function objectExists(sb: any, path: string): Promise<boolean> {
  const i = path.lastIndexOf('/')
  const dir = i >= 0 ? path.slice(0, i) : ''
  const name = i >= 0 ? path.slice(i + 1) : path
  const { data, error } = await sb.storage.from(BUCKET).list(dir, { search: name, limit: 10 })
  if (error) throw new Error(`storage list: ${error.message}`)
  return (data ?? []).some((o: any) => o?.name === name && o?.id)
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function whenText(rec: any): string {
  return new Date(rec.started_at ?? rec.created_at).toLocaleString('nl-BE', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Brussels',
  })
}

function reminderHtml(rec: any, name: string | null): string {
  const soort = rec.recording_type === 'phone' ? 'telefoongesprek' : 'fysieke meeting'
  return `
  <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;color:#1a2540">
    <div style="background:#1a2540;padding:18px 24px;border-radius:12px 12px 0 0">
      <span style="color:#fff;font-size:18px;font-weight:700">sales<span style="color:#FF6B35">Up</span> Capture</span>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:24px">
      <h2 style="margin:0 0 12px">Je opname is nog niet aangekomen</h2>
      <p style="line-height:1.55">${name ? `Hallo ${esc(name)},<br><br>` : ''}Je opname${rec.title ? ` <strong>"${esc(rec.title)}"</strong>` : ''}
        (${soort}) van <strong>${esc(whenText(rec))}</strong> is gestart, maar het audiobestand is nooit bij ons
        aangekomen. Daardoor konden we nog geen verslag maken.</p>
      <p style="line-height:1.55"><strong>Wat moet je doen?</strong> Open de salesUp Capture-app op de telefoon
        waarmee je de opname maakte. Daar staat ze klaar om opnieuw te versturen — tik op
        <em>Nu versturen</em>. Zorg voor een goede wifi- of 4G/5G-verbinding en laat de app even open tot het
        versturen klaar is. Het verslag volgt daarna automatisch per mail.</p>
      <p style="line-height:1.55;color:#6b7280">Heb je de app of de opname intussen verwijderd, dan kunnen we
        deze opname helaas niet meer herstellen.</p>
      <p style="color:#9ca3af;font-size:11px;margin-top:28px">
        Automatisch bericht van salesUp Capture. We sturen deze herinnering één keer per opname.
      </p>
    </div>
  </div>`
}

Deno.serve(async (req) => {
  const denied = cronForbidden(req); if (denied) return denied

  let body: any = {}
  try { body = await req.json() } catch { /* batch */ }
  const limit = Math.min(Number(body?.limit) || 50, 100)
  const dryRun = body?.dry_run === true

  const resendKey = (Deno.env.get('RESEND_API_KEY') ?? '').trim()
  if (!resendKey && !dryRun) return json({ ok: false, error: 'RESEND_API_KEY niet gezet als Edge Function secret' }, 500)
  const from = (Deno.env.get('CAPTURE_EMAIL_FROM') ?? 'salesUp Capture <capture@salesup.be>').trim()

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const cutoff = new Date(Date.now() - MIN_AGE_H * 3600_000).toISOString()
  const { data: todo, error: qErr } = await sb.from('recordings')
    .select('id, org_id, member_id, recording_type, title, started_at, created_at, storage_path, upload_reminder_sent_at')
    .eq('status', 'pending_upload')
    .in('recording_type', ['in_person', 'phone'])
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (qErr) return json({ ok: false, error: qErr.message }, 500)

  let reminded = 0, gaveUp = 0, hasFile = 0, skipped = 0, failed = 0
  const actions: any[] = []
  for (const rec of todo ?? []) {
    try {
      // Bestand wél aanwezig → upload gelukt; de app rondt 'complete' zelf af.
      if (rec.storage_path && await objectExists(sb, rec.storage_path)) {
        hasFile++; actions.push({ id: rec.id, action: 'has_file' }); continue
      }

      const ageMs = Date.now() - new Date(rec.created_at).getTime()
      if (ageMs > GIVE_UP_DAYS * 86400_000) {
        actions.push({ id: rec.id, action: 'give_up' })
        if (!dryRun) {
          await sb.from('recordings').update({ status: 'error', error: GIVE_UP_ERROR }).eq('id', rec.id).eq('status', 'pending_upload')
        }
        gaveUp++; continue
      }

      if (rec.upload_reminder_sent_at) { skipped++; continue }

      const { data: member } = rec.member_id
        ? await sb.from('members').select('email, full_name, is_active').eq('id', rec.member_id).maybeSingle()
        : { data: null }
      if (!member?.email || !member.is_active) {
        // Niemand om te mailen: markeren zodat we niet elk uur opnieuw proberen.
        actions.push({ id: rec.id, action: 'no_member' })
        if (!dryRun) await sb.from('recordings').update({ upload_reminder_sent_at: new Date().toISOString() }).eq('id', rec.id)
        skipped++; continue
      }

      actions.push({ id: rec.id, action: 'remind', to: member.email })
      if (dryRun) { reminded++; continue }

      const mail = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [member.email],
          subject: `Je opname van ${new Date(rec.started_at ?? rec.created_at).toLocaleDateString('nl-BE', { timeZone: 'Europe/Brussels' })} is nog niet verstuurd`,
          html: reminderHtml(rec, member.full_name ?? null),
        }),
      })
      if (!mail.ok) throw new Error(`Resend ${mail.status}: ${(await mail.text()).slice(0, 200)}`)

      await sb.from('recordings').update({ upload_reminder_sent_at: new Date().toISOString() }).eq('id', rec.id)
      reminded++
    } catch (e) {
      failed++
      console.error(`sweep-pending-uploads: ${rec.id}: ${e}`)
    }
  }

  console.log(`sweep-pending-uploads: todo=${(todo ?? []).length} reminded=${reminded} gave_up=${gaveUp} has_file=${hasFile} skipped=${skipped} failed=${failed}${dryRun ? ' (dry-run)' : ''}`)
  return json({
    ok: true, dry_run: dryRun, processed: (todo ?? []).length,
    reminded, gave_up: gaveUp, has_file: hasFile, skipped, failed,
    ...(dryRun ? { actions } : {}),
  })
})

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
