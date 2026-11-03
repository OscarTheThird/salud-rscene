// Admin only: see who asked for access and approve or deny from inside the app.
//   GET                          the last 7 days of requests (no keys or hashes), newest first
//   POST { id, action }          action = 'approve' | 'deny'; a request can be decided once, before or after its email is confirmed
// The caller needs a valid admin session cookie (the login gate already blocks everyone without a session).
import { COOKIE, verify, parseCookie } from '../_lib/session.js';
import { rest, dbReady } from '../_lib/db.js';
import { sameOrigin } from '../_lib/util.js';
import { UUID_RE, applyDecision } from '../_lib/access.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default {
  async fetch(request) {
    const secret = process.env.SESSION_SECRET;
    const me = await verify(parseCookie(request.headers.get('cookie') ?? '')[COOKIE], secret);
    if (me?.r !== 'admin') return json({ error: 'Admins only' }, 403);
    if (!dbReady() || !secret || secret.length < 32) return json({ error: 'Not configured' }, 500);
    try {
      if (request.method === 'GET') {
        const since = encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString());
        const r = await rest(`access_requests?select=id,name,email,org,country,status,created_at,verified_at,decided_at,claimed_at&created_at=gte.${since}&order=created_at.desc&limit=100`);
        return r.ok ? json({ requests: await r.json() }) : json({ error: 'Could not read requests' }, 502);
      }
      if (request.method === 'POST') {
        if (!sameOrigin(request)) return json({ error: 'Forbidden' }, 403);
        let b; try { b = await request.json(); } catch { /* handled below */ }
        if (!UUID_RE.test(b?.id ?? '') || !['approve', 'deny'].includes(b?.action)) return json({ error: 'Bad request' }, 400);
        const row = await applyDecision(b.id, b.action, { secret, origin: new URL(request.url).origin });
        return row ? json({ ok: true, status: row.status }) : json({ ok: false, error: 'Nothing changed. It may already be decided, or it has expired.' }, 409);
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch {
      return json({ error: 'Service unavailable' }, 502);
    }
  },
};
