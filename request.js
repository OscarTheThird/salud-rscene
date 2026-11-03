// Waiting page behind the emailed link: confirms the visitor's email, then waits for the admin's decision and,
// once approved, signs the visitor in and opens the app. The link's private key is sent only to our own server.
const $ = id => document.getElementById(id);
let r = new URLSearchParams(location.search).get('r');
// keep the key out of the address bar and history, but remember it for this tab so a reload still works
try { if (r) sessionStorage.setItem('salud.req', r); else r = sessionStorage.getItem('salud.req'); } catch { /* storage may be blocked */ }
history.replaceState(null, '', location.pathname);

const say = (title, msg, { spin = false, back = false } = {}) => {
  $('t').textContent = title; $('m').textContent = msg; $('spin').hidden = !spin; $('back').hidden = !back;
};
const END = {
  invalid: ['This link is not valid', 'Request access again from the sign-in page.'],
  expired: ['This link has expired', 'Request access again from the sign-in page.'],
  denied: ['Your request was not approved', 'You can contact the project owner if you think this is a mistake.'],
};
let timer = 0, errors = 0;

async function poll() {
  clearTimeout(timer);
  try {
    const res = await fetch('/api/access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'poll', r }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.state === 'in') { say('Approved', 'Opening SALUD…', { spin: true }); location.replace('/'); return; }
    if (res.ok && END[j.state]) { say(...END[j.state], { back: true }); return; }
    if (res.ok && j.state === 'waiting') { errors = 0; say('Waiting for approval', 'Your email is confirmed. This page will open automatically when your request is approved. Keep it open.', { spin: true }); }
    else if (++errors > 5) { say('Something went wrong', 'Reload this page to try again.', { back: true }); return; }
  } catch {
    if (++errors > 5) { say('Connection problem', 'Reload this page to try again.', { back: true }); return; }
  }
  timer = setTimeout(poll, 4000);
}

if (!r) say(...END.invalid, { back: true });
else {
  // already signed in (for example the page was reloaded after approval)? go straight to the app
  fetch('/api/session', { cache: 'no-store' }).then(x => (x.ok ? x.json() : null)).then(j => { if (j?.signedIn) location.replace('/'); else poll(); }).catch(poll);
}
