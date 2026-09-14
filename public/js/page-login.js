/* page-login.js — the PIN prompt in front of the control port.
 *
 * The only page the control port serves without a session. It is built from
 * `/api/auth`, which carries branding and nothing about the stand, so a
 * browser that has not given the PIN learns the stand's name and logo and
 * not one valve id. Nothing here imports bus.js: that module's first act is
 * to fetch the config, which is exactly what this page is not allowed yet.
 */
import { $, el, icon, toast } from './util.js';
import { currentTheme, toggleTheme, applyConfigDefault } from './theme.js';

const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));

/** Same rule as the server's: a path on this server, never a URL. */
function safeNext(candidate) {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  if (candidate.startsWith('/login.html')) return '/';
  return candidate;
}

let auth = {};
try {
  auth = await fetch('/api/auth').then((r) => r.json());
} catch { /* drawn with defaults below */ }

// Nothing to ask for, or already answered: straight through. Landing on the
// prompt with a session that is still good would read as having been logged
// out, which did not happen.
if (auth.required === false || auth.authenticated === true) {
  location.replace(next);
}

applyConfigDefault({ ui: { defaultTheme: auth.defaultTheme } });
if (auth.accent) document.documentElement.style.setProperty('--accent', auth.accent);
document.title = `${auth.brand || 'Ground Control'} · Unlock`;

const input = el('input#pin', {
  type: 'password',
  inputmode: 'numeric',
  pattern: '[0-9]*',
  autocomplete: 'off',
  autofocus: '',
  'aria-label': 'PIN',
  placeholder: '••••',
  maxlength: '12',
  // Enter submits through the form's implicit submission already; this is
  // for the on-screen keyboards that send a keydown and nothing else.
  onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); } },
});
const submit = el('button.btn.accent.wide#pin-go', { type: 'submit', html: `${icon('unlock', 15)} UNLOCK` });
const message = el('p.login-msg#login-msg', { text: '' });

const form = el('form.login-card', { onsubmit: onSubmit },
  el('div.login-brand', {},
    themedLogo(auth.logo, 'org-logo'),
    el('span.brand-mark', { text: auth.brand || 'Ground Control' }),
    auth.standName
      ? el('span.brand-stand', {}, themedLogo(auth.standLogo, 'stand-logo'), el('span', { text: auth.standName }))
      : null
  ),
  el('h1', { text: 'Control console' }),
  el('p.login-lead', {
    text: 'This address commands the stand. Enter the PIN to continue.',
  }),
  input,
  submit,
  message,
  el('p.login-foot', {
    html: `${icon('eye', 12)}<span>Just watching? Ask for the spectator address — it needs no PIN.</span>`,
  }),
);

document.body.append(
  el('div.login-page', {},
    form,
    el('button.icon-btn.login-theme#theme-toggle', {
      title: 'Toggle light / dark theme',
      'aria-label': 'Toggle theme',
      onclick: () => { toggleTheme(); syncThemeIcon(); },
    })
  )
);
syncThemeIcon();
requestAnimationFrame(() => { document.body.classList.add('theme-ready'); input.focus(); });

let lockedUntil = 0;
let countdown = null;

async function onSubmit(e) {
  e.preventDefault();
  if (Date.now() < lockedUntil) return;
  const pin = input.value.trim();
  if (!pin) { input.focus(); return; }

  submit.disabled = true;
  let res, json;
  try {
    res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    json = await res.json();
  } catch (err) {
    submit.disabled = false;
    toast(`Could not reach the server: ${err.message}`, 'error');
    return;
  }

  if (json.ok) {
    message.dataset.kind = 'ok';
    message.textContent = 'Unlocked';
    location.replace(next);
    return;
  }

  input.value = '';
  form.classList.remove('shake');
  void form.offsetWidth;           // restart the animation
  form.classList.add('shake');
  message.dataset.kind = 'error';

  if (json.retryAfterMs > 0) {
    lockedUntil = Date.now() + json.retryAfterMs;
    tickCountdown(json.error);
  } else {
    message.textContent = json.error || 'Wrong PIN';
    submit.disabled = false;
    input.focus();
  }
}

/**
 * A lockout is shown as a count, not as a dead button. A button that just
 * refuses looks like the page broke; a count says the page is working and
 * exactly when it will listen again.
 */
function tickCountdown(reason) {
  clearInterval(countdown);
  const paint = () => {
    const left = Math.ceil((lockedUntil - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(countdown);
      message.textContent = 'Try again';
      submit.disabled = false;
      input.focus();
      return;
    }
    message.textContent = `${reason} — ${left} s`;
  };
  paint();
  countdown = setInterval(paint, 250);
}

function themedLogo(spec, className) {
  if (!spec || (!spec.light && !spec.dark)) return null;
  const img = el(`img.${className}`, {
    alt: spec.alt || '',
    style: spec.height ? { height: `${spec.height}px` } : {},
  });
  const apply = () => {
    const dark = currentTheme() === 'dark';
    img.src = (dark ? spec.dark : spec.light) || spec.light || spec.dark;
  };
  apply();
  window.addEventListener('themechange', apply);
  return img;
}

function syncThemeIcon() {
  const btn = $('#theme-toggle');
  if (btn) btn.innerHTML = icon(currentTheme() === 'dark' ? 'sun' : 'moon');
}
