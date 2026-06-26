// salesUp Capture — register-push: bewaart de Expo push-token op de member.
// Auth: verify_jwt=true (user-JWT vanuit de app). Body: { token }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const { data: { user }, error: uErr } = await sb.auth.getUser(token)
  if (uErr || !user) return json({ error: 'unauthorized' }, 401)

  let body: any = {}
  try { body = await req.json() } catch { /* */ }
  const pushToken = String(body?.token ?? '').trim()
  if (!/^Expo(nent)?PushToken\[.+\]$/.test(pushToken)) return json({ error: 'ongeldige push-token' }, 400)

  const { error } = await sb.from('members').update({ expo_push_token: pushToken }).eq('user_id', user.id)
  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
})

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })
}
