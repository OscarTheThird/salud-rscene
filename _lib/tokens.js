// Temporary 6-digit access tokens: made by an admin, redeemed once by a guest. Only a keyed hash of each code is stored.
export const TOKEN_TTL_MIN = 30;                // a token must be used within 30 minutes of being made
export const GUEST_TTL_S = 3 * 3600;            // a guest session lasts 3 hours
export const WINDOW_MIN = 10, MAX_FAILS_IP = 5, MAX_FAILS_ALL = 40;   // wrong-token limits, per address and for everyone

// uniform random 6-digit code (rejection sampling, so no modulo bias)
export function makeCode() {
  const buf = new Uint32Array(1), limit = 2 ** 32 - (2 ** 32 % 1e6);
  let n;
  do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= limit);
  return String(n % 1e6).padStart(6, '0');
}

export async function hmacHex(value, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// reject cross-site form posts: a request that names an Origin must come from this site
export function sameOrigin(request) {
  const o = request.headers.get('origin');
  if (!o) return true;
  try { return new URL(o).host === new URL(request.url).host; } catch { return false; }
}

export const emails = v => (v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
