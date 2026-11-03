// Login page: Supabase email + password, then /api/session turns it into the site's cookie.
// The URL and publishable key below are public by design (they only allow sign-in; signups are disabled in Supabase).
// No token or password is stored in the browser.
const SB = 'https://anrugoxkeprcsthheajq.supabase.co';
const KEY = 'sb_publishable_6Ming0-Ros-pf9WNla1IMw_RoddUJ-Y';
const $ = id => document.getElementById(id);
const f = $('f'), go = $('go'), err = $('err'), pw = $('pw');

$('show').addEventListener('click', () => {
  const on = pw.type === 'password';
  pw.type = on ? 'text' : 'password';
  $('show').textContent = on ? 'Hide' : 'Show';
  $('show').setAttribute('aria-pressed', String(on));
});

const fail = msg => { err.textContent = msg; go.disabled = false; go.textContent = 'Sign in'; };

f.addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('email').value.trim(), password = pw.value;
  if (!email || !password) { fail('Enter your email and password.'); return; }
  go.disabled = true; go.textContent = 'Signing in…'; err.textContent = '';
  try {
    const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    if (!r.ok) { fail(r.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Incorrect email or password.'); return; }
    const { access_token } = await r.json();
    const s = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token }), credentials: 'same-origin' });
    if (!s.ok) { fail(s.status === 500 ? 'The site is not fully set up yet. Tell the project owner.' : s.status === 403 ? 'This account has not been invited to the preview.' : 'Could not start your session. Try again.'); return; }
    location.replace('/');
  } catch {
    fail('Network problem. Check your connection and try again.');
  }
});
