// The admin's Approve / Deny links from the notification email.
//   GET  shows the request and a button (opening the link never decides anything, so mail scanners can't approve by accident)
//   POST makes the decision, once. If approved, the visitor is emailed a link and the waiting page signs them in.
// Each link is signed for one request and one action, and expires after 24 hours.
import { rest, dbReady } from '../_lib/db.js';
import { sameOrigin, safeEqual, esc } from '../_lib/util.js';
import { mailer } from '../_lib/mail.js';
import { REQUEST_TTL_H, UUID_RE, decideSig, requestLink, approvedEmail, page } from '../_lib/access.js';

const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
const bad = () => html(page('Link not valid', '<h1>This link is not valid</h1><p class="m">It may have expired or been altered.</p>'), 403);

export default {
  async fetch(request) {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32 || !dbReady()) return html(page('Not configured', '<h1>The site is not configured</h1>'), 500);
    const url = new URL(request.url);
    let p = url.searchParams;
    if (request.method === 'POST') {
      if (!sameOrigin(request)) return bad();
      p = new URLSearchParams(await request.text());
    } else if (request.method !== 'GET') return html(page('Not allowed', '<h1>Not allowed</h1>'), 405);

    const id = p.get('id') ?? '', a = p.get('a') ?? '', e = Number(p.get('e')), s = p.get('s') ?? '', now = Date.now();
    if (!UUID_RE.test(id) || !['approve', 'deny'].includes(a) || !Number.isFinite(e) || e < now || e > now + REQUEST_TTL_H * 3600000 + 60000
      || !safeEqual(s, await decideSig(id, a, e, secret))) return bad();

    try {
      const row = (await (await rest(`access_requests?id=eq.${id}&select=*`)).json())[0];
      if (!row) return bad();
      const who = `<dl><dt>Name</dt><dd>${esc(row.name)}</dd><dt>Email</dt><dd>${esc(row.email)}</dd><dt>Organization</dt><dd>${esc(row.org || '-')}</dd><dt>Country</dt><dd>${esc(row.country || '-')}</dd></dl>`;
      const word = a === 'approve' ? 'Approve' : 'Deny';

      if (request.method === 'GET') {
        if (row.status !== 'awaiting') return html(page('Already handled', `<h1>Already handled</h1>${who}<p class="m">This request is ${esc(row.status === 'pending_email' ? 'waiting for the email to be confirmed' : row.status)}.</p>`));
        return html(page(`${word} access`, `<h1>${word} access?</h1>${who}<form method="post" action="/api/decide"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="a" value="${esc(a)}"><input type="hidden" name="e" value="${esc(e)}"><input type="hidden" name="s" value="${esc(s)}"><button class="${a === 'approve' ? 'ok' : 'no'}" type="submit">${word}</button></form>`));
      }

      const t = await rest(`access_requests?id=eq.${id}&status=eq.awaiting&created_at=gt.${encodeURIComponent(new Date(now - REQUEST_TTL_H * 3600000).toISOString())}`,
        { method: 'PATCH', prefer: 'return=representation', body: { status: a === 'approve' ? 'approved' : 'denied', decided_at: new Date(now).toISOString() } });
      const changed = t.ok ? await t.json() : [];
      if (!changed.length) return html(page('Already handled', `<h1>Already handled</h1>${who}<p class="m">Nothing was changed.</p>`));
      if (a === 'approve') {
        try { await mailer.send({ to: row.email, ...approvedEmail({ name: row.name, url: await requestLink(url.origin, id, secret) }) }); } catch { /* the waiting page still signs them in */ }
      }
      return html(page('Done', `<h1>${a === 'approve' ? 'Approved' : 'Denied'}</h1>${who}<p class="m">${a === 'approve' ? 'They are signed in automatically if their page is open, and they have been emailed a link.' : 'They will not be signed in.'}</p>`));
    } catch {
      return html(page('Error', '<h1>Something went wrong</h1><p class="m">Try the link again.</p>'), 502);
    }
  },
};
