// Public: ask for access and wait for the admin's decision.
//   POST { action: 'request', name, email, org, website }   starts a request and emails a confirmation link
//   POST { action: 'poll', r }                              r = the private key from the emailed link; confirms the email,
//                                                           tells the admin, and signs the visitor in once approved
// The visitor sees only "waiting"; the time limit is applied silently (cookie lifetime, ACCESS_MIN).
import { sign, cookieHeader } from '../_lib/session.js';
import { rest, dbReady } from '../_lib/db.js';
import { hmacHex, sameOrigin, safeEqual, emails } from '../_lib/util.js';
import { mailer } from '../_lib/mail.js';
import { GUEST_TTL_S, REQUEST_TTL_H, CLAIM_H, LIMITS, EMAIL_RE, UUID_RE, clean, requestKey, requestLink, decideLink, verifyEmail, adminEmail } from '../_lib/access.js';

const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const q = encodeURIComponent;
const ago = (ms, now) => q(new Date(now - ms).toISOString());

async function count(path) {                      // exact row count; Infinity if unavailable, so limits fail closed
  const r = await rest(path, { prefer: 'count=exact', headers: { Range: '0-0' } });
  const m = /\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
  return r.ok && m ? Number(m[1]) : Infinity;
}

async function startRequest(request, body, secret, now) {
  if (body.website) return json({ ok: true });                                   // honeypot: a bot filled the hidden field
  const name = clean(body.name, 80), email = clean(body.email, 254).toLowerCase(), org = clean(body.org, 120);
  if (name.length < 2 || !EMAIL_RE.test(email)) return json({ error: 'Enter your name and a valid email address.' }, 400);

  const ip = (request.headers.get('x-real-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0] || 'unknown').trim();
  const ipHash = await hmacHex(`ip:${ip}`, secret);
  const hour = 3600000;
  if ((await count(`access_requests?select=id&ip_hash=eq.${ipHash}&created_at=gte.${ago(hour, now)}`)) >= LIMITS.ipPerHour
    || (await count(`access_requests?select=id&created_at=gte.${ago(hour, now)}`)) >= LIMITS.allPerHour) {
    return json({ error: 'Too many requests. Try again later.' }, 429);
  }
  // the same address asking again and again gets the same answer but no more email (no mail-bombing a third party)
  if ((await count(`access_requests?select=id&email=eq.${q(email)}&created_at=gte.${ago(24 * hour, now)}`)) >= LIMITS.emailPerDay) return json({ ok: true });

  const r = await rest('access_requests', { method: 'POST', prefer: 'return=representation', body: { name, email, org: org || null, ip_hash: ipHash, country: request.headers.get('x-vercel-ip-country') || null } });
  const row = r.ok ? (await r.json())[0] : null;
  if (!row) return json({ error: 'Could not send your request. Try again.' }, 502);
  try {
    await mailer.send({ to: email, ...verifyEmail({ name, url: await requestLink(new URL(request.url).origin, row.id, secret) }) });
  } catch {
    await rest(`access_requests?id=eq.${row.id}`, { method: 'DELETE' });
    return json({ error: 'We could not send an email to that address. Check it and try again.' }, 502);
  }
  return json({ ok: true });
}

async function poll(request, body, secret, now) {
  const [id, key] = String(body.r ?? '').split('.');
  if (!UUID_RE.test(id ?? '') || !key || !safeEqual(key, await requestKey(id, secret))) return json({ state: 'invalid' });
  const get = async () => (await (await rest(`access_requests?id=eq.${id}&select=*`)).json())[0];
  const row = await get();
  if (!row) return json({ state: 'invalid' });

  const created = Date.parse(row.created_at);
  const lapsed = now - created > REQUEST_TTL_H * 3600000;
  const iso = new Date(now).toISOString();

  if (row.status === 'pending_email' || row.status === 'awaiting') {
    if (lapsed) return json({ state: 'expired' });
    if (row.status === 'pending_email') {                                         // first visit to the link: the email is confirmed
      const t = await rest(`access_requests?id=eq.${id}&status=eq.pending_email`, { method: 'PATCH', prefer: 'return=representation', body: { status: 'awaiting', verified_at: iso } });
      if (t.ok && (await t.json()).length) {                                      // only the request that made the change tells the admin
        const origin = new URL(request.url).origin;
        const to = emails(process.env.APPROVER_EMAIL)[0] || emails(process.env.ADMIN_EMAILS)[0];
        try {
          if (!to) throw new Error('no approver');
          await mailer.send({ to, ...adminEmail({ name: row.name, email: row.email, org: row.org, country: row.country, createdAt: row.created_at,
            approveUrl: await decideLink(origin, id, 'approve', secret, now), denyUrl: await decideLink(origin, id, 'deny', secret, now) }) });
        } catch {
          await rest(`access_requests?id=eq.${id}&status=eq.awaiting`, { method: 'PATCH', body: { status: 'pending_email', verified_at: null } });   // try again on the next poll
          return json({ error: 'Could not reach the approver. Trying again.' }, 502);
        }
      }
    }
    return json({ state: 'waiting' });
  }
  if (row.status === 'denied') return json({ state: 'denied' });
  if (row.status === 'approved') {
    if (now - Date.parse(row.decided_at) > CLAIM_H * 3600000) return json({ state: 'expired' });
    // one atomic step, so a link can be used by one browser only
    const c = await rest(`access_requests?id=eq.${id}&status=eq.approved`, { method: 'PATCH', prefer: 'return=representation', body: { status: 'claimed', claimed_at: iso } });
    if (!(c.ok && (await c.json()).length)) return json({ state: 'expired' });
    const exp = Math.floor(now / 1000) + GUEST_TTL_S;
    const cookie = cookieHeader(await sign({ e: `guest:${row.email}`, r: 'guest', exp }, secret), GUEST_TTL_S);
    return json({ state: 'in' }, 200, { 'Set-Cookie': cookie });
  }
  return json({ state: 'expired' });                                              // claimed already
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!sameOrigin(request)) return json({ error: 'Forbidden' }, 403);
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32 || !dbReady()) return json({ error: 'Server is not configured' }, 500);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
    try {
      if (body?.action === 'request') return await startRequest(request, body, secret, Date.now());
      if (body?.action === 'poll') return await poll(request, body, secret, Date.now());
      return json({ error: 'Bad request' }, 400);
    } catch {
      return json({ error: 'Service unavailable' }, 502);
    }
  },
};
