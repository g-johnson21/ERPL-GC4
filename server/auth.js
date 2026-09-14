/**
 * auth.js — the PIN gate on the control port.
 *
 * The control URL is printed in the banner, and a banner gets read over
 * shoulders. Before this, anyone who could reach the port could open the
 * Control Grid and start clicking valves; the spectator port only ever made
 * the read-only address easier to share, it did nothing to make the control
 * address harder to use. A PIN is the smallest thing that does.
 *
 * What the gate is:
 *   - every control-port request needs a session cookie, except the login
 *     page itself, the assets it draws with, and the two routes that create
 *     or read a session (`isPublic`);
 *   - a session is a random token, issued by `login()` against the configured
 *     PIN, held in memory, and gone when the server restarts or `SESSION_TTL_MS`
 *     runs out — so a phone that unlocked the stand last month is not still
 *     unlocked this month;
 *   - guessing is throttled per address: a handful of misses earns a lockout
 *     that doubles on every further miss, which turns the ten thousand
 *     four-digit PINs into a job that takes days rather than seconds, and
 *     every miss is written to the event log so the operator sees it happen.
 *
 * What it is not: a security boundary. The PIN travels in plain HTTP on the
 * stand's own network and lives in `stand.json` where the Config page can
 * change it. It stops the honest accident and the idle hand on a shared
 * network, and it says who is expected at the console. The spectator port
 * takes no PIN at all — it cannot command the stand, so there is nothing for
 * a PIN to protect, and a viewing address that needs a code does not get
 * shared.
 */
import crypto from 'node:crypto';

/** How long a session lasts. A test day, with margin; not a term. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Consecutive misses from one address before it is locked out. */
export const LOCKOUT_AFTER = 5;
/** First lockout, doubled on every miss after it, up to LOCKOUT_MAX_MS. */
export const LOCKOUT_BASE_MS = 30 * 1000;
export const LOCKOUT_MAX_MS = 15 * 60 * 1000;

export const COOKIE_NAME = 'gc4_session';
export const LOGIN_PAGE = '/login.html';

/** Where a request goes when it needs a PIN: the login page, and the assets that page loads. */
const PUBLIC_ASSET_DIRS = new Set(['css', 'js', 'img']);

/** A PIN is 4–12 digits, or empty to run the control port open. */
export function validPin(pin) {
  return pin === '' || /^\d{4,12}$/.test(pin);
}

/**
 * @param {object} options
 * @param {string} [options.pin]   The PIN; '' or undefined leaves the gate open.
 * @param {(level: string, message: string) => void} [options.log]
 * @param {() => number} [options.now]   Injectable clock, for the tests.
 */
export function createAccessGate({ pin = '', log = () => {}, now = Date.now } = {}) {
  let currentPin = String(pin ?? '');
  const sessions = new Map();   // token -> { ip, createdAt, expiresAt }
  const attempts = new Map();   // ip -> { fails, lockedUntil }

  function prune() {
    const t = now();
    for (const [token, s] of sessions) if (s.expiresAt <= t) sessions.delete(token);
  }

  return {
    get enabled() { return currentPin !== ''; },

    /** Hot-reload hook: a changed PIN applies to the next login; sessions stand. */
    setPin(next) {
      const value = String(next ?? '');
      if (!validPin(value)) throw new Error('A control PIN is 4–12 digits, or empty to disable it');
      currentPin = value;
    },

    /**
     * Requests that go through without a session. Deliberately a short list:
     * the login page, the css/js/img it is built from, the route it posts to
     * and the one it reads its branding from. Everything else — every page,
     * every API — waits for the cookie. `HEAD` counts as `GET`.
     */
    isPublic(method, pathname) {
      const m = method === 'HEAD' ? 'GET' : method;
      if (m === 'GET' && pathname === LOGIN_PAGE) return true;
      if (m === 'GET' && pathname === '/favicon.ico') return true;
      if (m === 'GET' && pathname === '/api/auth') return true;
      if (m === 'POST' && (pathname === '/api/login' || pathname === '/api/logout')) return true;
      if (m === 'GET' && !pathname.startsWith('/api/')) {
        const top = pathname.split('/').filter(Boolean)[0];
        if (PUBLIC_ASSET_DIRS.has(top)) return true;
      }
      return false;
    },

    /**
     * Try a PIN from an address. On success the caller gets a token to set as
     * the cookie; on failure, how long that address has to wait before the
     * next try is even looked at.
     */
    login(candidate, ip = 'unknown') {
      const t = now();
      const rec = attempts.get(ip) || { fails: 0, lockedUntil: 0 };
      if (rec.lockedUntil > t) {
        return { ok: false, error: 'Too many wrong PINs — wait before trying again', retryAfterMs: rec.lockedUntil - t };
      }

      if (currentPin !== '' && sameString(String(candidate ?? ''), currentPin)) {
        attempts.delete(ip);
        prune();
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { ip, createdAt: t, expiresAt: t + SESSION_TTL_MS });
        log('info', `Control console unlocked from ${ip}`);
        return { ok: true, token };
      }

      rec.fails += 1;
      let retryAfterMs = 0;
      if (rec.fails >= LOCKOUT_AFTER) {
        retryAfterMs = Math.min(LOCKOUT_MAX_MS, LOCKOUT_BASE_MS * 2 ** (rec.fails - LOCKOUT_AFTER));
        rec.lockedUntil = t + retryAfterMs;
      }
      attempts.set(ip, rec);
      // Every miss is in the log. One is a typo; a run of them, from an
      // address nobody at the console recognises, is worth knowing about
      // while it is happening.
      log('warn', `Wrong control PIN from ${ip}`
        + (retryAfterMs ? ` — locked out for ${Math.round(retryAfterMs / 1000)} s` : ''));
      return {
        ok: false,
        error: retryAfterMs ? 'Wrong PIN — too many tries, wait before trying again' : 'Wrong PIN',
        retryAfterMs,
      };
    },

    /** The session behind a request, or null. Reads the cookie header itself. */
    authenticate(req) {
      const token = readCookie(req.headers?.cookie, COOKIE_NAME);
      return this.session(token);
    },

    session(token) {
      if (!token) return null;
      const s = sessions.get(token);
      if (!s) return null;
      if (s.expiresAt <= now()) { sessions.delete(token); return null; }
      return s;
    },

    logout(token) {
      const s = sessions.get(token);
      if (s) {
        sessions.delete(token);
        log('info', `Control console locked from ${s.ip}`);
      }
      return Boolean(s);
    },

    /** `Set-Cookie` values. HttpOnly so a script cannot lift it; no Secure flag, since the stand speaks plain HTTP. */
    cookie(token) {
      return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
    },
    clearCookie() {
      return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
    },

    tokenOf(req) {
      return readCookie(req.headers?.cookie, COOKIE_NAME);
    },

    /** For the tests and the banner. */
    get sessionCount() { prune(); return sessions.size; },
  };
}

/**
 * The redirect target a login page may bounce back to: a path on this
 * server, never a URL. `//evil` is a protocol-relative URL and is refused.
 */
export function safeNext(candidate) {
  if (typeof candidate !== 'string' || !candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  if (candidate.startsWith(LOGIN_PAGE)) return '/';
  return candidate;
}

/** Constant-time string compare, so a PIN cannot be guessed a digit at a time from timing. */
function sameString(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still burn a comparison so length is the only thing timing reveals.
    crypto.timingSafeEqual(bb, bb);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
