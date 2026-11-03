// Vercel Function: turns a Supabase sign-in into the site's session cookie, with a role.
//   POST { access_token }  checks the token with Supabase, then sets the signed HttpOnly cookie
//   GET                    { signedIn, role } (the app uses it to show "Sign out" and the admin menu)
//   GET ?logout            clears the cookie and goes back to the login page
// Roles: admin (email in ADMIN_EMAILS), viewer (email in ALLOWED_EMAILS), guest (made by /api/token-login).
// Needs SESSION_SECRET (32+ random characters) and ADMIN_EMAILS and/or ALLOWED_EMAILS (comma-separated).
// The Supabase URL and publishable key are public.
import { COOKIE, TTL_S, sign, verify, parseCookie, cookieHeader } from '../_lib/session.js';
import { emails, sameOrigin } from '../_lib/tokens.js';

const SB = process.env.SUPABASE_URL || 'https://anrugoxkeprcsthheajq.supabase.co';
const KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_6Ming0-Ros-pf9WNla1IMw_RoddUJ-Y';
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

export default {
  async fetch(request) {
    const secret = process.env.SESSION_SECRET;
    const url = new URL(request.url);
    if (request.method === 'GET' && url.searchParams.has('logout')) {
      return new Response(null, { status: 302, headers: { Location: '/login.html', 'Set-Cookie': cookieHeader('', 0), 'Cache-Control': 'no-store' } });
    }
    if (request.method === 'GET') {
      const p = await verify(parseCookie(request.headers.get('cookie') ?? '')[COOKIE], secret);
      return json(p ? { signedIn: true, role: p.r ?? 'viewer' } : { signedIn: false });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!sameOrigin(request)) return json({ error: 'Forbidden' }, 403);
    if (!secret || secret.length < 32) return json({ error: 'Server is not configured' }, 500);

    let token;
    try { ({ access_token: token } = await request.json()); } catch { /* handled below */ }
    if (typeof token !== 'string' || !token || token.length > 4096) return json({ error: 'Bad request' }, 400);

    // Only invited people get in, even if Supabase signups were ever left on: the email must be listed and confirmed.
    const admins = emails(process.env.ADMIN_EMAILS), viewers = emails(process.env.ALLOWED_EMAILS);
    if (!admins.length && !viewers.length) return json({ error: 'Server is not configured' }, 500);

    const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    const user = r.ok ? await r.json() : null;
    if (!user?.email) return json({ error: 'Not signed in' }, 401);
    const email = String(user.email).toLowerCase();
    const role = admins.includes(email) ? 'admin' : viewers.includes(email) ? 'viewer' : null;
    if (!user.email_confirmed_at || !role) return json({ error: 'This account is not invited' }, 403);

    const exp = Math.floor(Date.now() / 1000) + TTL_S;
    return json({ ok: true, role }, 200, { 'Set-Cookie': cookieHeader(await sign({ e: user.email, r: role, exp }, secret), TTL_S) });
  },
};
