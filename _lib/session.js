// Signed session cookie for the login gate. Pure Web Crypto, so it runs the same in Vercel Middleware, a Vercel
// Function and Node tests. The cookie is "<base64url payload>.<base64url HMAC-SHA256>"; the secret never leaves the server.
export const COOKIE = 'salud_session';
export const TTL_S = 8 * 3600;                         // a session lasts one working day

const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hmacKey = secret => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function sign(payload, secret) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64u(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)))}`;
}

// the payload if the token is genuine and not expired, else null (never throws)
export async function verify(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(parts[1]), enc.encode(parts[0])))) return null;
    const p = JSON.parse(dec.decode(unb64u(parts[0])));
    return p && typeof p.exp === 'number' && p.exp * 1000 > now ? p : null;
  } catch { return null; }
}

export function parseCookie(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const cookieHeader = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
