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

// ---- temporary sign in with a 6-digit token (made by the admin) ----
const tf = $('tf'), tok = $('tok'), tgo = $('tgo'), terr = $('terr');
function showToken(on) {
  tf.hidden = !on; f.hidden = on; $('orRow').hidden = on; $('toToken').hidden = on;
  (on ? tok : $('email')).focus();
}
$('toToken').addEventListener('click', () => showToken(true));
$('toEmail').addEventListener('click', () => showToken(false));
tok.addEventListener('input', () => {                       // digits only, shown as "123 456"
  const d = tok.value.replace(/\D/g, '').slice(0, 6);
  tok.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
  terr.textContent = '';
});
tf.addEventListener('submit', async e => {
  e.preventDefault();
  const code = tok.value.replace(/\D/g, '');
  if (code.length !== 6) { terr.textContent = 'Enter all 6 digits.'; return; }
  tgo.disabled = true; tgo.textContent = 'Checking…'; terr.textContent = '';
  const stop = msg => { terr.textContent = msg; tgo.disabled = false; tgo.textContent = 'Continue with token'; };
  try {
    const r = await fetch('/api/token-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), credentials: 'same-origin' });
    if (r.ok) { location.replace('/'); return; }
    stop(r.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : r.status === 401 ? 'That token is invalid or has expired.' : r.status === 500 ? 'Token sign-in is not set up yet. Tell the project owner.' : 'Could not sign in with that token. Try again.');
  } catch {
    stop('Network problem. Check your connection and try again.');
  }
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
