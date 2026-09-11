import { afterEach, describe, expect, it } from 'vitest';

import { admin, harness, problemOf, signIn, userWith, type Harness } from './helpers.js';

/**
 * `/api/users` — §4 FR-6: "login, roles, password reset by admin". A password
 * an admin types for someone is the admin's, so the account comes up needing
 * a password of its owner's choosing.
 */

let h: Harness;
afterEach(async () => {
  await h.close();
});

const TEMPORARY = 'a temporary one for jo';

async function idOf(caller: Awaited<ReturnType<typeof admin>>): Promise<string> {
  return (await caller.request({ method: 'GET', url: '/api/auth/me' })).json().user.id;
}

describe('/api/users', () => {
  it('lets an admin add an estimator, who then chooses their own password', async () => {
    h = await harness();
    const me = await admin(h);
    const created = await me.request({
      method: 'POST',
      url: '/api/users',
      payload: { username: 'Jo', password: TEMPORARY, role: 'estimator', displayName: 'Jo' },
    });

    expect(created.statusCode).toBe(201);
    const jo = created.json();
    expect(created.headers['location']).toBe(`/api/users/${jo.id}`);
    expect(jo).toMatchObject({ username: 'jo', role: 'estimator', mustChangePassword: true });
    expect(created.body).not.toMatch(/argon2|passwordHash/);

    const signedIn = await signIn(h.app, 'jo', TEMPORARY);
    const blocked = await signedIn.request({ method: 'GET', url: '/api/config' });
    expect(problemOf(blocked).type).toBe('urn:shopquote:problem:password-change-required');
  });

  it('holds a new account’s password to the same policy', async () => {
    h = await harness();
    const me = await admin(h);
    const response = await me.request({
      method: 'POST',
      url: '/api/users',
      payload: { username: 'jo', password: 'short', role: 'estimator' },
    });
    expect(response.statusCode).toBe(422);
    expect(problemOf(response).errors?.[0]?.pointer).toBe('/password');
  });

  it('resets a password: every session ends, and the user chooses again', async () => {
    h = await harness();
    const me = await admin(h);
    const jo = await userWith(h, 'estimator', 'jo');
    const joId = await idOf(jo);

    const reset = await me.request({
      method: 'POST',
      url: `/api/users/${joId}/password`,
      payload: { newPassword: 'reset by the admin today' },
    });
    expect(reset.statusCode).toBe(204);
    expect((await jo.request({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);

    const again = await signIn(h.app, 'jo', 'reset by the admin today');
    const whoami = await again.request({ method: 'GET', url: '/api/auth/me' });
    expect(whoami.json().user.mustChangePassword).toBe(true);
  });

  it('changes a role, removes an account, and will not let an admin remove themselves', async () => {
    h = await harness();
    const me = await admin(h);
    const removeSelf = await me.request({ method: 'DELETE', url: `/api/users/${await idOf(me)}` });
    expect(removeSelf.statusCode).toBe(409);
    expect(problemOf(removeSelf).type).toBe('urn:shopquote:problem:conflict');

    const joId = await idOf(await userWith(h, 'estimator', 'jo'));
    const promoted = await me.request({
      method: 'PUT',
      url: `/api/users/${joId}`,
      payload: { displayName: 'Jo', email: 'jo@example.com', role: 'owner' },
    });
    expect(promoted.json()).toMatchObject({ role: 'owner', email: 'jo@example.com' });

    expect((await me.request({ method: 'DELETE', url: `/api/users/${joId}` })).statusCode).toBe(
      204,
    );
    const users = await me.request({ method: 'GET', url: '/api/users' });
    expect(users.json().map((u: { username: string }) => u.username)).toEqual(['admin']);
  });
});
