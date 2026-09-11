import { afterEach, describe, expect, it } from 'vitest';

import { harness, problemOf, type Harness } from './helpers.js';

/**
 * problem+json for everything that goes wrong (CLAUDE.md, RFC 9457) — not
 * only the errors routes throw on purpose, but Fastify's own and the ones
 * nobody planned for.
 */

let h: Harness;
afterEach(async () => {
  await h.close();
});

describe('errors', () => {
  it('answers an unknown route with a problem, not an HTML page', async () => {
    h = await harness();
    const response = await h.app.inject({ method: 'GET', url: '/api/nothing-here' });
    expect(response.statusCode).toBe(404);
    expect(problemOf(response)).toMatchObject({
      type: 'urn:shopquote:problem:not-found',
      instance: '/api/nothing-here',
    });
  });

  it('turns malformed JSON into a 400', async () => {
    h = await harness();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"username":',
    });
    expect(response.statusCode).toBe(400);
    expect(problemOf(response).type).toBe('urn:shopquote:problem:bad-request');
  });

  it('wants JSON', async () => {
    h = await harness();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: 'admin',
    });
    expect(response.statusCode).toBe(415);
    expect(problemOf(response).type).toBe('urn:shopquote:problem:unsupported-media-type');
  });

  it('says nothing about the internals when something breaks', async () => {
    h = await harness();
    h.app.get('/api/boom', { config: { access: 'public' } }, async () => {
      throw new Error('secret: the table layout');
    });
    const response = await h.app.inject({ method: 'GET', url: '/api/boom' });
    expect(response.statusCode).toBe(500);
    expect(problemOf(response).type).toBe('urn:shopquote:problem:internal');
    expect(response.body).not.toContain('secret');
  });
});
