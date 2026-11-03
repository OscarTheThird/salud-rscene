// Admin only: make, list and revoke temporary access tokens.
//   POST    makes one token: { id, code, expiresAt }. The code is shown once; only its hash is stored.
//   GET     the last 24 hours of tokens with their state (no codes)
//   DELETE  revokes every unused token
// The caller must carry a valid admin session cookie (the login gate already blocks everyone else).
import { COOKIE, verify, parseCookie } from '../_lib/session.js';
import { rest, dbReady } from '../_lib/db.js';
import { makeCode, hmacHex, sameOrigin, TOKEN_TTL_MIN } from '../_lib/tokens.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const q = encodeURIComponent;

export default {
  async fetch(request) {
    const secret = process.env.SESSION_SECRET;
    const me = await verify(parseCookie(request.headers.get('cookie') ?? '')[COOKIE], secret);
    if (me?.r !== 'admin' || !sameOrigin(request)) return json({ error: 'Admins only' }, 403);
    if (!dbReady() || !secret || secret.length < 32) return json({ error: 'Token service is not configured' }, 500);

    const now = new Date(), iso = d => d.toISOString();
    try {
      if (request.method === 'GET') {
        const r = await rest(`access_tokens?select=id,created_at,expires_at,used_at&created_at=gte.${q(iso(new Date(now - 864e5)))}&order=created_at.desc&limit=100`);
        return r.ok ? json({ tokens: await r.json() }) : json({ error: 'Could not read tokens' }, 502);
      }
      if (request.method === 'POST') {
        await rest(`access_attempts?at=lt.${q(iso(new Date(now - 864e5)))}`, { method: 'DELETE' });     // tidy old rows
        await rest(`access_tokens?created_at=lt.${q(iso(new Date(now - 2 * 864e5)))}`, { method: 'DELETE' });
        for (let i = 0; i < 6; i++) {
          const code = makeCode(), hash = await hmacHex(`code:${code}`, secret);
          const clash = await rest(`access_tokens?select=id&code_hash=eq.${hash}&used_at=is.null&expires_at=gt.${q(iso(now))}&limit=1`);
          if (!clash.ok) return json({ error: 'Could not make a token' }, 502);
          if ((await clash.json()).length) continue;                                  // same code already active: draw again
          const expires = new Date(now.getTime() + TOKEN_TTL_MIN * 60000);
          const r = await rest('access_tokens', { method: 'POST', prefer: 'return=representation', body: { code_hash: hash, created_by: me.e, role: 'guest', expires_at: iso(expires) } });
          const row = r.ok ? (await r.json())[0] : null;
          return row ? json({ id: row.id, code, expiresAt: row.expires_at }) : json({ error: 'Could not make a token' }, 502);
        }
        return json({ error: 'Could not make a token' }, 502);
      }
      if (request.method === 'DELETE') {
        const r = await rest(`access_tokens?used_at=is.null&expires_at=gt.${q(iso(now))}`, { method: 'PATCH', prefer: 'return=representation', body: { expires_at: iso(now) } });
        return r.ok ? json({ revoked: (await r.json()).length }) : json({ error: 'Could not revoke' }, 502);
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch {
      return json({ error: 'Token service is unavailable' }, 502);
    }
  },
};
