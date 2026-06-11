// ============================================================================
// salesUp Capture — summarize-email
// ============================================================================
// Voor elke getranscribeerde opname: Nederlandse samenvatting + actielijst via
// Claude, opslaan in summaries, en mailen naar de eigenaar van de opname via
// Resend (transcript optioneel mee, per org instelbaar). Draait elke 10 min.
//
// Modi:  POST {} (batch, default 5, max 10) | { recording_id } | { limit }
// Secrets: ANTHROPIC_API_KEY, RESEND_API_KEY
//          CAPTURE_EMAIL_FROM   (default: salesUp Capture <capture@salesup.be>)
//          SUMMARY_MODEL        (default: claude-haiku-4-5-20251001)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MODEL_DEFAULT = 'claude-haiku-4-5-20251001'

async function summarize(anthropicKey: string, model: string, rec: any): Promise<{ summary: string; action_items: any[] }> {
  const transcript = String(rec.full_text).slice(0, 150_000) // ruim; lange calls afkappen
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content:
`Je bent de meeting-assistent van salesUp. Hieronder staat het transcript van een ${rec.recording_type === 'phone' ? 'telefoongesprek' : rec.recording_type === 'in_person' ? 'fysieke meeting' : 'videocall'}${rec.title ? ` met als titel "${rec.title}"` : ''}.

Maak in het Nederlands:
1. Een beknopte, zakelijke samenvatting (max ~200 woorden): context, besproken punten, beslissingen, sfeer/koopsignalen indien relevant.
2. Een concrete actielijst.

Antwoord UITSLUITEND met geldige JSON in dit formaat:
{"samenvatting": "...", "actiepunten": [{"actie": "...", "eigenaar": "naam of null", "deadline": "tekst of null"}]}

TRANSCRIPT:
${transcript}`,
      }],
    }),
  })
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const out = await res.json()
  const text = (out?.content ?? []).map((b: any) => b?.text ?? '').join('')
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Claude gaf geen JSON terug')
  const parsed = JSON.parse(match[0])
  return {
    summary: String(parsed.samenvatting ?? '').trim(),
    action_items: Array.isArray(parsed.actiepunten) ? parsed.actiepunten : [],
  }
}

function emailHtml(rec: any, summary: string, actions: any[]): string {
  const dt = new Date(rec.started_at).toLocaleString('nl-BE', { dateStyle: 'full', timeStyle: 'short' })
  const dur = rec.duration_seconds ? `${Math.round(rec.duration_seconds / 60)} min` : ''
  const actionsHtml = actions.length
    ? `<ul>${actions.map((a: any) =>
        `<li><strong>${esc(a.actie ?? '')}</strong>${a.eigenaar ? ` — ${esc(a.eigenaar)}` : ''}${a.deadline ? ` <em>(${esc(a.deadline)})</em>` : ''}</li>`
      ).join('')}</ul>`
    : '<p><em>Geen actiepunten gedetecteerd.</em></p>'
  const transcriptHtml = rec.include_transcript
    ? `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
       <details><summary style="cursor:pointer;color:#6b7280">Volledig transcript</summary>
       <pre style="white-space:pre-wrap;font-size:12px;color:#374151">${esc(String(rec.full_text).slice(0, 200_000))}</pre></details>`
    : ''
  return `
  <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;color:#1a2540">
    <div style="background:#1a2540;padding:18px 24px;border-radius:12px 12px 0 0">
      <span style="color:#fff;font-size:18px;font-weight:700">sales<span style="color:#FF6B35">Up</span> Capture</span>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:24px">
      <h2 style="margin:0 0 4px">${esc(rec.title || 'Gespreksverslag')}</h2>
      <p style="color:#6b7280;font-size:13px;margin:0 0 20px">${dt}${dur ? ` · ${dur}` : ''}</p>
      <h3 style="font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:#FF6B35">Samenvatting</h3>
      <p style="line-height:1.55">${esc(summary).replace(/\n/g, '<br>')}</p>
      <h3 style="font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:#FF6B35">Actiepunten</h3>
      ${actionsHtml}
      ${transcriptHtml}
      <p style="color:#9ca3af;font-size:11px;margin-top:28px">
        Automatisch gegenereerd door salesUp Capture. Dit verslag kan vertrouwelijke
        informatie bevatten — niet doorsturen buiten je organisatie.
      </p>
    </div>
  </div>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

Deno.serve(async (req) => {
  const anthropicKey = (Deno.env.get('ANTHROPIC_API_KEY') ?? '').trim()
  const resendKey = (Deno.env.get('RESEND_API_KEY') ?? '').trim()
  if (!anthropicKey || !resendKey) {
    return json({ ok: false, error: 'ANTHROPIC_API_KEY en/of RESEND_API_KEY niet gezet als Edge Function secret' }, 500)
  }
  const from = (Deno.env.get('CAPTURE_EMAIL_FROM') ?? 'salesUp Capture <capture@salesup.be>').trim()
  const model = (Deno.env.get('SUMMARY_MODEL') ?? MODEL_DEFAULT).trim()

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let body: any = {}
  try { body = await req.json() } catch { /* batch */ }
  const limit = Math.min(Number(body?.limit) || 5, 10)

  let todo: any[] = []
  if (body?.recording_id) {
    const { data } = await sb.from('v_pending_summary').select('*').eq('id', body.recording_id).limit(1)
    todo = data ?? []
  } else {
    const { data } = await sb.from('v_pending_summary')
      .select('*').order('started_at', { ascending: true }).limit(limit)
    todo = data ?? []
  }

  let sent = 0, failed = 0
  for (const rec of todo) {
    try {
      const { summary, action_items } = await summarize(anthropicKey, model, rec)

      await sb.from('summaries').upsert({
        recording_id: rec.id, summary, action_items, model, error: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'recording_id' })

      const mail = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [rec.member_email],
          subject: `Gespreksverslag: ${rec.title || new Date(rec.started_at).toLocaleDateString('nl-BE')}`,
          html: emailHtml(rec, summary, action_items),
        }),
      })
      if (!mail.ok) throw new Error(`Resend ${mail.status}: ${(await mail.text()).slice(0, 200)}`)

      await sb.from('summaries').update({
        email_to: rec.member_email,
        email_sent_at: new Date().toISOString(),
      }).eq('recording_id', rec.id)
      sent++
    } catch (e) {
      failed++
      await sb.from('summaries').upsert({
        recording_id: rec.id, error: String(e).slice(0, 500),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'recording_id' })
    }
  }

  console.log(`summarize-email: todo=${todo.length} sent=${sent} failed=${failed}`)
  return json({ ok: true, processed: todo.length, sent, failed })
})

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
