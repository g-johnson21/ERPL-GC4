/**
 * Tests for the control-port PIN gate.
 *
 *   node --test server/auth.test.js
 *
 * The properties that matter are the ones a browser cannot show: that a wrong
 * PIN never yields a session, that guessing is throttled, that a session ends
 * when it should, and that the list of routes reachable without one is short.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAccessGate, safeNext, validPin,
  LOCKOUT_AFTER, LOCKOUT_BASE_MS, SESSION_TTL_MS, COOKIE_NAME,
} from './auth.js';
import { validateConfig } from './config-store.js';

function gate(pin = '4321') {
  let t = 1_000_000;
  const log = [];
  const g = createAccessGate({ pin, log: (level, message) => log.push({ level, message }), now: () => t });
  return { g, log, tick: (ms) => { t += ms; } };
}

const reqWith = (token) => ({ headers: { cookie: `theme=dark; ${COOKIE_NAME}=${token}` } });

test('no PIN configured means the gate is open, and nothing logs in', () => {
  const { g } = gate('');
  assert.equal(g.enabled, false);
  assert.equal(g.login('', '10.0.0.2').ok, false);
});

test('the right PIN issues a session; the wrong one issues nothing', () => {
  const { g, log } = gate();
  assert.equal(g.login('0000', '10.0.0.2').ok, false);
  assert.equal(g.authenticate(reqWith('made-up')), null);

  const res = g.login('4321', '10.0.0.2');
  assert.equal(res.ok, true);
  assert.match(res.token, /^[0-9a-f]{64}$/);
  assert.equal(g.authenticate(reqWith(res.token)).ip, '10.0.0.2');
  assert.equal(g.authenticate({ headers: {} }), null);
  assert.ok(log.some((e) => e.level === 'warn' && /wrong control pin/i.test(e.message)));
  assert.ok(log.some((e) => e.level === 'info' && /unlocked from 10\.0\.0\.2/.test(e.message)));
});

test('a PIN of the right length but wrong digits, and a number that is a prefix, are both wrong', () => {
  const { g } = gate('123456');
  assert.equal(g.login('1234', 'a').ok, false);
  assert.equal(g.login('1234567', 'a').ok, false);
  assert.equal(g.login(123456, 'a').ok, true);   // a numeric body still compares as its digits
});

test('repeated misses from one address lock it out, and the lockout grows', () => {
  const { g, tick } = gate();
  const ip = '10.0.0.9';
  for (let i = 1; i < LOCKOUT_AFTER; i++) assert.equal(g.login('1111', ip).retryAfterMs, 0);

  const locked = g.login('1111', ip);
  assert.equal(locked.retryAfterMs, LOCKOUT_BASE_MS);

  // Even the RIGHT PIN is refused while locked — otherwise the lockout only
  // slows down a guesser who has already stopped guessing.
  const during = g.login('4321', ip);
  assert.equal(during.ok, false);
  assert.ok(during.retryAfterMs > 0 && during.retryAfterMs <= LOCKOUT_BASE_MS);

  tick(LOCKOUT_BASE_MS + 1);
  assert.equal(g.login('1111', ip).retryAfterMs, LOCKOUT_BASE_MS * 2);

  // Another address is unaffected.
  assert.equal(g.login('4321', '10.0.0.10').ok, true);

  tick(LOCKOUT_BASE_MS * 2 + 1);
  assert.equal(g.login('4321', ip).ok, true);
  // ...and success clears the record.
  assert.equal(g.login('1111', ip).retryAfterMs, 0);
});

test('a session expires, and logout ends it early', () => {
  const { g, tick } = gate();
  const { token } = g.login('4321', 'x');
  tick(SESSION_TTL_MS - 1);
  assert.ok(g.session(token));
  tick(2);
  assert.equal(g.session(token), null);

  const { token: second } = g.login('4321', 'x');
  assert.equal(g.logout(second), true);
  assert.equal(g.session(second), null);
  assert.equal(g.logout(second), false);
});

test('changing the PIN applies to the next login and keeps existing sessions', () => {
  const { g } = gate();
  const { token } = g.login('4321', 'x');
  g.setPin('9999');
  assert.ok(g.session(token));
  assert.equal(g.login('4321', 'y').ok, false);
  assert.equal(g.login('9999', 'y').ok, true);
  assert.throws(() => g.setPin('12'), /4–12 digits/);
  assert.throws(() => g.setPin('abcd'), /4–12 digits/);
  g.setPin('');
  assert.equal(g.enabled, false);
});

test('only the login page, its assets and the session routes are public', () => {
  const { g } = gate();
  for (const [m, p] of [
    ['GET', '/login.html'], ['HEAD', '/login.html'], ['GET', '/css/base.css'], ['GET', '/js/page-login.js'],
    ['GET', '/img/draco.png'], ['GET', '/favicon.ico'], ['GET', '/api/auth'],
    ['POST', '/api/login'], ['POST', '/api/logout'],
  ]) assert.equal(g.isPublic(m, p), true, `${m} ${p} should be public`);

  for (const [m, p] of [
    ['GET', '/'], ['GET', '/index.html'], ['GET', '/pid.html'], ['GET', '/data.html'], ['GET', '/config.html'],
    ['GET', '/api/config'], ['GET', '/api/state'], ['GET', '/api/stream'], ['POST', '/api/valve'],
    ['POST', '/api/arm'], ['PUT', '/api/config'], ['GET', '/api/record/download/x.csv'],
    ['POST', '/css/base.css'], ['GET', '/api/login'],
  ]) assert.equal(g.isPublic(m, p), false, `${m} ${p} should need a session`);
});

test('the cookie is HttpOnly and scoped to the site', () => {
  const { g } = gate();
  const c = g.cookie('abc');
  assert.match(c, new RegExp(`^${COOKIE_NAME}=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
  assert.match(g.clearCookie(), /Max-Age=0/);
});

test('the post-login redirect only ever goes to a path on this server', () => {
  assert.equal(safeNext('/pid.html'), '/pid.html');
  assert.equal(safeNext('/data.html?x=1'), '/data.html?x=1');
  assert.equal(safeNext('//evil.example/'), '/');
  assert.equal(safeNext('https://evil.example/'), '/');
  assert.equal(safeNext('/login.html?next=/'), '/');
  assert.equal(safeNext(undefined), '/');
});

test('validateConfig accepts a digit PIN or none, and refuses anything else', () => {
  assert.equal(validPin(''), true);
  assert.equal(validPin('1234'), true);
  assert.equal(validPin('123456789012'), true);
  assert.equal(validPin('123'), false);
  assert.equal(validPin('12 34'), false);
  assert.equal(validPin('abcd'), false);

  const base = { meta: {}, ui: { pages: [] }, valves: [], sensors: [], autosequences: [] };
  assert.deepEqual(validateConfig({ ...base, safety: { controlPin: '2468' } }).filter((e) => /controlPin/.test(e)), []);
  assert.ok(validateConfig({ ...base, safety: { controlPin: 'nope' } }).some((e) => /controlPin/.test(e)));
  assert.ok(validateConfig({ ...base, safety: { controlPin: 1234 } }).some((e) => /controlPin/.test(e)));
});
