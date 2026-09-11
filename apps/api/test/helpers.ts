import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';

import {
  createUser,
  listUsers,
  openMigratedMemoryDatabase,
  seedBlankShop,
  seedWorkbookShop,
  type DatabaseHandle,
  type Role,
} from '@shopquote/db';

import { SESSION_COOKIE } from '../src/auth/guard.js';
import { buildServer } from '../src/server.js';

/** The seed's bootstrap password — the one that has to be changed. */
export const BOOTSTRAP_PASSWORD = 'bootstrap password';
/** A password its owner chose: long enough for the policy. */
export const CHOSEN_PASSWORD = 'an admin chose this one';

/** A clock the test moves by hand. Starts at the real time, because the
 *  database layer stamps rows with the real time too. */
export class Clock {
  constructor(public now: Date = new Date()) {}
  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }
}

export interface Harness {
  app: FastifyInstance;
  handle: DatabaseHandle;
  shopId: string;
  clock: Clock;
  close(): Promise<void>;
}

/** A server over a fresh in-memory database: the workbook shop, or a blank one. */
export async function harness(kind: 'workbook' | 'blank' = 'workbook'): Promise<Harness> {
  const handle = openMigratedMemoryDatabase();
  const { shopId } =
    kind === 'workbook'
      ? await seedWorkbookShop(handle, { adminPassword: BOOTSTRAP_PASSWORD })
      : await seedBlankShop(handle, { adminPassword: BOOTSTRAP_PASSWORD });
  const clock = new Clock();
  const app = await buildServer({ db: handle, shopId, logger: false, now: () => clock.now });
  return {
    app,
    handle,
    shopId,
    clock,
    close: async () => {
      await app.close();
      handle.close();
    },
  };
}

/** Requests carrying one session cookie. */
export interface Caller {
  token: string;
  request(options: InjectOptions): Promise<LightMyRequestResponse>;
}

export function as(app: FastifyInstance, token: string): Caller {
  return {
    token,
    request: (options) =>
      app.inject({ ...options, cookies: { ...options.cookies, [SESSION_COOKIE]: token } }),
  };
}

export async function signIn(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<Caller> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in as ${username}: ${response.statusCode} ${response.body}`);
  }
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
  if (cookie === undefined) throw new Error('sign-in set no session cookie');
  return as(app, cookie.value);
}

/** The seeded admin, signed in and past the forced password change: day one. */
export async function admin(h: Harness): Promise<Caller> {
  const caller = await signIn(h.app, 'admin', BOOTSTRAP_PASSWORD);
  const changed = await caller.request({
    method: 'PUT',
    url: '/api/auth/password',
    payload: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: CHOSEN_PASSWORD },
  });
  if (changed.statusCode !== 200) {
    throw new Error(`password change: ${changed.statusCode} ${changed.body}`);
  }
  return caller;
}

/** Another account, with a password its owner chose, signed in. */
export async function userWith(h: Harness, role: Role, username: string = role): Promise<Caller> {
  const creator = listUsers(h.handle.db, h.shopId).find((u) => u.role === 'admin');
  if (creator === undefined) throw new Error('no admin to create users with');
  await createUser(
    h.handle,
    h.shopId,
    { username, password: CHOSEN_PASSWORD, role, mustChangePassword: false },
    { userId: creator.id },
  );
  return signIn(h.app, username, CHOSEN_PASSWORD);
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  errors?: { pointer: string; detail: string }[];
}

/** An error response's problem+json body (RFC 9457), with its shape checked. */
export function problemOf(response: LightMyRequestResponse): Problem {
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = response.json<Problem>();
  expect(body.status).toBe(response.statusCode);
  expect(body.type).toMatch(/^urn:shopquote:problem:/);
  return body;
}

/** Audit actions recorded against one row, oldest first. */
export function auditActions(h: Harness, entityId: string): string[] {
  const rows = h.handle.sqlite
    .prepare('SELECT action FROM audit_log WHERE entity_id = ? ORDER BY rowid')
    .all(entityId) as { action: string }[];
  return rows.map((r) => r.action);
}
