// Server-only access to the Supabase tables behind the temporary tokens. Uses the secret (service role) key, which lives
// only in Vercel's environment variables and is never sent to a browser. The tables have RLS on and no public grants.
export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://anrugoxkeprcsthheajq.supabase.co';
export const dbReady = () => !!process.env.SUPABASE_SERVICE_ROLE_KEY;

export function rest(path, { method = 'GET', body, prefer, headers = {} } = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const h = { apikey: key, 'Content-Type': 'application/json', ...headers };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;      // legacy JWT keys also need the bearer header
  if (prefer) h.Prefer = prefer;
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
