import { randomBytes, scryptSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../src/auth/guard.js';
import {
  admin,
  BOOTSTRAP_PASSWORD,
  CHOSEN_PASSWORD,
  harness,
  problemOf,
  signIn,
  userWith,
  type Harness,
} from './helpers.js';

/**
 * §2 auth, §4 FR-6 and §7 security, through HTTP: a session cookie good for
 * twelve hours, a throttle on failed sign-ins, a bootstrap password that has
 * to be replaced before anything else, and roles that decide who may change
 * Settings.
 */

let h: Harness;
afterEach(async () => {
  await h.close();
});

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

describe('signing in', () => {
  it('sets an HttpOnly, SameSite=Strict session cookie good for twelve hours', async () => {
    h = await harness();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'Admin', password: BOOTSTRAP_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.username).toBe('admin');
    expect(body.user.mustChangePassword).toBe(true);
    expect(response.body).not.toContain('passwordHash');
    expect(new Date(body.expiresAt).getTime()).toBe(h.clock.now.getTime() + TWELVE_HOURS);

    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 43_200 });
  });

  it('answers a wrong password and an unknown user identically', async () => {
    h = await harness();
    const attempt = (username: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username, password: 'not the password' },
      });
    const wrongPassword = await attempt('admin');
    const noSuchUser = await attempt('nobody');
    expect(wrongPassword.statusCode).toBe(401);
    expect(problemOf(noSuchUser)).toEqual(problemOf(wrongPassword));
  });

  it('stops a guesser after five failures, and says when to come back', async () => {
    h = await harness();
    const attempt = (password: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password },
      });

    for (let i = 0; i < 5; i += 1) expect((await attempt(`guess ${i}`)).statusCode).toBe(401);
    // Even the right password waits: the throttle is consulted first.
    const blocked = await attempt(BOOTSTRAP_PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('900');
    expect(problemOf(blocked).type).toBe('urn:shopquote:problem:too-many-attempts');

    h.clock.advance(15 * 60 * 1000);
    expect((await attempt(BOOTSTRAP_PASSWORD)).statusCode).toBe(200);
  });

  it('upgrades a password stored before argon2id at its owner’s next sign-in', async () => {
    h = await harness();
    // A row as Task 2.1 wrote it.
    const salt = randomBytes(16);
    const key = scryptSync(BOOTSTRAP_PASSWORD, salt, 32, { N: 16384, r: 8, p: 1 });
    const legacy = `$scrypt$n=16384,r=8,p=1$${salt.toString('base64')}$${key.toString('base64')}`;
    h.handle.sqlite.prepare('UPDATE users SET password_hash = ?').run(legacy);

    await signIn(h.app, 'admin', BOOTSTRAP_PASSWORD);

    const stored = h.handle.sqlite.prepare('SELECT password_hash AS hash FROM users').get() as {
      hash: string;
    };
    expect(stored.hash).toMatch(/^\$argon2id\$/);
    const login = h.handle.sqlite
      .prepare("SELECT summary FROM audit_log WHERE action = 'auth.login'")
      .get() as { summary: string };
    expect(login.summary).toMatch(/password hash upgraded/);
  });
});

describe('the first sign-in', () => {
  it('holds a bootstrap password to the password page until it is changed', async () => {
    h = await harness();
    const first = await signIn(h.app, 'admin', BOOTSTRAP_PASSWORD);

    const blocked = await first.request({ method: 'GET', url: '/api/config' });
    expect(blocked.statusCode).toBe(403);
    expect(problemOf(blocked).type).toBe('urn:shopquote:problem:password-change-required');
    expect((await first.request({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(200);

    const tooShort = await first.request({
      method: 'PUT',
      url: '/api/auth/password',
      payload: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: 'Tr0ub4dor&3' },
    });
    expect(tooShort.statusCode).toBe(422);
    expect(problemOf(tooShort).errors).toEqual([
      { pointer: '/newPassword', detail: 'Use at least 15 characters — a few words is easiest.' },
    ]);

    const changed = await first.request({
      method: 'PUT',
      url: '/api/auth/password',
      payload: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: CHOSEN_PASSWORD },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().user.mustChangePassword).toBe(false);
    expect((await first.request({ method: 'GET', url: '/api/config' })).statusCode).toBe(200);
  });

  it('wants the current password, even from a signed-in session', async () => {
    h = await harness();
    const first = await signIn(h.app, 'admin', BOOTSTRAP_PASSWORD);
    const response = await first.request({
      method: 'PUT',
      url: '/api/auth/password',
      payload: { currentPassword: 'a guess', newPassword: CHOSEN_PASSWORD },
    });
    expect(response.statusCode).toBe(422);
    expect(problemOf(response).errors?.[0]?.pointer).toBe('/currentPassword');
  });
});

describe('sessions', () => {
  it('end twelve hours after sign-in, and the cookie is withdrawn', async () => {
    h = await harness();
    const me = await admin(h);
    h.clock.advance(TWELVE_HOURS - 1);
    expect((await me.request({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(200);

    h.clock.advance(1);
    const expired = await me.request({ method: 'GET', url: '/api/auth/me' });
    expect(expired.statusCode).toBe(401);
    expect(expired.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
  });

  it('end for good on signing out', async () => {
    h = await harness();
    const me = await admin(h);
    expect((await me.request({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(204);
    expect((await me.request({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
  });

  it('end everywhere else when a password changes', async () => {
    h = await harness();
    const here = await admin(h);
    const there = await signIn(h.app, 'admin', CHOSEN_PASSWORD);
    const changed = await here.request({
      method: 'PUT',
      url: '/api/auth/password',
      payload: { currentPassword: CHOSEN_PASSWORD, newPassword: 'yet another long password' },
    });
    expect(changed.statusCode).toBe(200);
    expect((await there.request({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    expect((await here.request({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(200);
  });
});

describe('roles', () => {
  it('lets everyone read Settings, and only owners and admins change them', async () => {
    h = await harness();
    const estimator = await userWith(h, 'estimator');
    const owner = await userWith(h, 'owner');

    const read = await estimator.request({ method: 'GET', url: '/api/config' });
    expect(read.statusCode).toBe(200);
    const { defaults, parity, enabledModules } = read.json();
    const settings = { defaults, parity, enabledModules };

    const denied = await estimator.request({
      method: 'PUT',
      url: '/api/config',
      payload: settings,
    });
    expect(denied.statusCode).toBe(403);
    expect(problemOf(denied).detail).toBe(
      'This needs owner or admin; you are signed in as estimator.',
    );
    const price = await estimator.request({
      method: 'POST',
      url: '/api/materials/anything/price',
      payload: { pricePerLbUsd: 1 },
    });
    expect(price.statusCode).toBe(403);

    expect(
      (await owner.request({ method: 'PUT', url: '/api/config', payload: settings })).statusCode,
    ).toBe(200);
  });

  it('keeps accounts to admins', async () => {
    h = await harness();
    const owner = await userWith(h, 'owner');
    expect((await owner.request({ method: 'GET', url: '/api/users' })).statusCode).toBe(403);
    const me = await admin(h);
    const users = await me.request({ method: 'GET', url: '/api/users' });
    expect(users.json().map((u: { username: string }) => u.username)).toEqual(['admin', 'owner']);
  });

  it('asks for a session everywhere but the health check', async () => {
    h = await harness();
    const anonymous = await h.app.inject({ method: 'GET', url: '/api/config' });
    expect(anonymous.statusCode).toBe(401);
    expect(problemOf(anonymous).type).toBe('urn:shopquote:problem:unauthenticated');
    expect((await h.app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({
      status: 'ok',
    });
  });
});
