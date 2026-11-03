// Request-access flow, shared by api/access.js and api/decide.js.
//   visitor asks (name + email) -> confirms the email from a link -> waits -> the admin approves from an email
//   -> the waiting page signs the visitor in for ACCESS_MIN minutes (single use).
import { hmacHex, esc } from './util.js';
import { rest } from './db.js';
import { mailer } from './mail.js';

export const ACCESS_MIN = 30, GUEST_TTL_S = ACCESS_MIN * 60;     // how long an approved visitor stays signed in
export const REQUEST_TTL_H = 24;                                 // a request must be confirmed and decided within a day
export const CLAIM_H = 2;                                        // an approved visitor must open the link within 2 hours
export const LIMITS = { ipPerHour: 3, allPerHour: 30, emailPerDay: 2 };
export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

// the private key in a visitor's link: derived from the server secret, so nothing secret is stored
export const requestKey = (id, secret) => hmacHex(`req:${id}`, secret);
export const requestLink = async (origin, id, secret) => `${origin}/request.html?r=${id}.${await requestKey(id, secret)}`;

// admin decision links: signed, expiring, and each one is for one action on one request
export const decideSig = (id, action, exp, secret) => hmacHex(`decide:${id}:${action}:${exp}`, secret);
export async function decideLink(origin, id, action, secret, now = Date.now()) {
  const exp = now + REQUEST_TTL_H * 3600 * 1000;
  return `${origin}/api/decide?id=${id}&a=${action}&e=${exp}&s=${await decideSig(id, action, exp, secret)}`;
}

const btn = (href, label, bg) => `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;margin:0 8px 8px 0;background:${bg};color:#ffffff;text-decoration:none;border-radius:8px;font-weight:700;font-family:Segoe UI,Arial,sans-serif">${label}</a>`;
const wrap = body => `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1b2735;max-width:520px">${body}</div>`;

export function verifyEmail({ name, url }) {
  return {
    subject: 'Confirm your email to continue your SALUD access request',
    text: `Hi ${name},\n\nConfirm your email address to continue your request to view the SALUD preview:\n${url}\n\nIf you did not ask for this, ignore this message.`,
    html: wrap(`<p>Hi ${esc(name)},</p><p>Confirm your email address to continue your request to view the SALUD preview.</p><p>${btn(url, 'Confirm email and continue', '#1b7f9e')}</p><p style="color:#5b6b7c;font-size:13px">If you did not ask for this, ignore this message.</p>`),
  };
}

export function adminEmail({ name, email, org, country, createdAt, approveUrl, denyUrl, confirmed }) {
  const when = new Date(createdAt).toUTCString();
  return {
    subject: `SALUD access request: ${name} <${email}>`,
    text: `${confirmed ? 'Access request (email confirmed)' : 'New access request (email not confirmed yet)'}\n\nName: ${name}\nEmail: ${email}\nOrganization: ${org || '-'}\nCountry (from IP): ${country || '-'}\nRequested: ${when}\n\n${confirmed ? '' : 'Even if you approve now, they can only sign in after they confirm their email.\n\n'}Approve: ${approveUrl}\nDeny: ${denyUrl}\n\nThe links work for 24 hours.`,
    html: wrap(`<p style="font-size:17px;font-weight:700;margin:0 0 10px">${confirmed ? 'Access request <span style="color:#1c8a4f">(email confirmed)</span>' : 'New access request <span style="color:#b8860b">(email not confirmed yet)</span>'}</p>
      <table style="border-collapse:collapse;margin:0 0 16px"><tr><td style="padding:3px 14px 3px 0;color:#5b6b7c">Name</td><td><b>${esc(name)}</b></td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#5b6b7c">Email</td><td><b>${esc(email)}</b></td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#5b6b7c">Organization</td><td>${esc(org || '-')}</td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#5b6b7c">Country (from IP)</td><td>${esc(country || '-')}</td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#5b6b7c">Requested</td><td>${esc(when)}</td></tr></table>
      <p>${btn(approveUrl, 'Approve', '#1c8a4f')}${btn(denyUrl, 'Deny', '#b3382c')}</p>
      <p style="color:#5b6b7c;font-size:13px">${confirmed ? '' : 'Even if you approve now, they can only sign in after they confirm their email. '}Each button opens a confirmation page first. The links work for 24 hours.</p>`),
  };
}

export function approvedEmail({ name, url }) {
  return {
    subject: 'Your SALUD access request was approved',
    text: `Hi ${name},\n\nYour request was approved. Open the preview here:\n${url}`,
    html: wrap(`<p>Hi ${esc(name)},</p><p>Your request was approved.</p><p>${btn(url, 'Open SALUD', '#1b7f9e')}</p>`),
  };
}

// The admin's decision, used by the email links (api/decide.js) and the in-app list (api/requests.js).
// A request under a day old can be decided once, before or after its email is confirmed; the visitor still has to open their emailed link to get in.
// Returns the updated row, or null if nothing changed. An approval also emails the visitor a link.
export async function applyDecision(id, action, { secret, origin, now = Date.now() }) {
  const since = encodeURIComponent(new Date(now - REQUEST_TTL_H * 3600000).toISOString());
  const t = await rest(`access_requests?id=eq.${id}&status=in.(pending_email,awaiting)&created_at=gt.${since}`,
    { method: 'PATCH', prefer: 'return=representation', body: { status: action === 'approve' ? 'approved' : 'denied', decided_at: new Date(now).toISOString() } });
  const row = t.ok ? (await t.json())[0] : null;
  if (!row) return null;
  if (action === 'approve') {
    try { await mailer.send({ to: row.email, ...approvedEmail({ name: row.name, url: await requestLink(origin, id, secret) }) }); } catch { /* the waiting page still signs them in */ }
  }
  return row;
}

// a small standalone page for the admin's confirm / result screens
export const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#06101d;color:#e6f0fb;font:15px/1.5 "Segoe UI",system-ui,sans-serif}.c{width:min(440px,100%);background:#0b1d35;border:1px solid #1b3a5e;border-radius:14px;padding:24px}h1{margin:0 0 12px;font-size:19px}dl{margin:0 0 18px;display:grid;grid-template-columns:auto 1fr;gap:4px 14px}dt{color:#8fb2d6}dd{margin:0;font-weight:600;word-break:break-word}button{height:44px;padding:0 22px;border:0;border-radius:8px;color:#fff;font:inherit;font-weight:700;cursor:pointer}.ok{background:#1c8a4f}.no{background:#b3382c}.m{color:#8fb2d6}</style></head><body><main class="c">${body}</main></body></html>`;
