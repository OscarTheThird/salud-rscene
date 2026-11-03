// Public: trade a temporary 6-digit token for a guest session (3 hours, view only).
//   POST { code }
// A token works once. Wrong guesses are limited per address and for everyone, because 6 digits is a small space.
import { COOKIE, sign, cookieHeader } from '../_lib/session.js';
import { rest, dbReady } from '../_lib/db.js';
import { hmacHex, sameOrigin, GUEST_TTL_S, WINDOW_MIN, MAX_FAILS_IP, MAX_FAILS_ALL } from '../_lib/tokens.js';

const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const q = encodeURIComponent;

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!sameOrigin(request)) return json({ error: 'Forbidden' }, 403);
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32 || !dbReady()) return json({ error: 'Server is not configured' }, 500);

    let code;
    try { ({ code } = await request.json()); } catch { /* handled below */ }
    code = typeof code === 'string' ? code.replace(/\s/g, '') : '';
    if (!/^\d{6}$/.test(code)) return json({ error: 'Enter the 6-digit token' }, 400);

    try {
      const now = new Date(), iso = d => d.toISOString();
      const ip = (request.headers.get('x-real-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0] || 'unknown').trim();
      const ipHash = await hmacHex(`ip:${ip}`, secret);
      const since = q(iso(new Date(now - WINDOW_MIN * 60000)));
      const fails = async extra => {
        const r = await rest(`access_attempts?select=id&at=gte.${since}${extra}`, { prefer: 'count=exact', headers: { Range: '0-0' } });
        const m = /\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
        return r.ok && m ? Number(m[1]) : Infinity;                                  // if the count is unavailable, lock (fail closed)
      };
      if ((await fails(`&ip_hash=eq.${ipHash}`)) >= MAX_FAILS_IP || (await fails('')) >= MAX_FAILS_ALL) {
        return json({ error: 'Too many attempts. Wait a few minutes and try again.' }, 429);
      }

      // one atomic step: mark the matching unused, unexpired token as used and get it back
      const hash = await hmacHex(`code:${code}`, secret);
      const r = await rest(`access_tokens?code_hash=eq.${hash}&used_at=is.null&expires_at=gt.${q(iso(now))}`, { method: 'PATCH', prefer: 'return=representation', body: { used_at: iso(now) } });
      const rows = r.ok ? await r.json() : [];
      if (!rows.length) {
        await rest('access_attempts', { method: 'POST', body: { ip_hash: ipHash } });
        return json({ error: 'That token is invalid or has expired.' }, 401);
      }
      const exp = Math.floor(now.getTime() / 1000) + GUEST_TTL_S;
      const session = await sign({ e: `guest:${String(rows[0].id).slice(0, 8)}`, r: 'guest', exp }, secret);
      return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(session, GUEST_TTL_S) });
    } catch {
      return json({ error: 'Token sign-in is unavailable' }, 502);
    }
  },
};
