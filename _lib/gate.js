// The access rule for the whole site: only the login page and script, the request-access page and endpoints, the session
// check and the two logos are public. Everything else (the app, its scripts and every data file) needs a valid session cookie.
import { COOKIE, parseCookie, verify } from './session.js';

export const PUBLIC = new Set(['/login.html', '/login.js', '/request.html', '/request.js', '/api/session', '/api/access', '/api/decide', '/assets/SALUD-LOGO-sm.png', '/assets/SALUD-mark.png', '/favicon.ico']);

// null = let the request through; otherwise the Response to send instead
export async function gate(request, secret) {
  const { pathname } = new URL(request.url);
  if (PUBLIC.has(pathname)) return null;
  if (await verify(parseCookie(request.headers.get('cookie') ?? '')[COOKIE], secret)) return null;
  const page = request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html');
  return page
    ? new Response(null, { status: 302, headers: { Location: '/login.html', 'Cache-Control': 'no-store' } })
    : new Response('Sign in required', { status: 401, headers: { 'Cache-Control': 'no-store' } });
}
