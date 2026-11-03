// Vercel Routing Middleware: runs in front of every request. No valid session cookie, no files.
// If SESSION_SECRET is missing, nobody gets in (fail closed).
import { next } from '@vercel/functions';
import { gate } from './_lib/gate.js';

export default async function middleware(request) {
  const denied = await gate(request, process.env.SESSION_SECRET);
  if (denied) return denied;
  return next({ headers: { 'Cache-Control': 'private, no-cache' } });
}
