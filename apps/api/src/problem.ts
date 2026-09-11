/**
 * Errors as RFC 9457 problem details (CLAUDE.md: "problem+json from the API").
 *
 * Every error the API returns has the same shape — `type`, `title`, `status`,
 * `detail`, `instance`, and for a validation failure an `errors` list of JSON
 * Pointers into the body — so the web app has one place to turn a failure into
 * an amber note beside the right field. `type` is a URN rather than a URL: it
 * is an identifier for the client to switch on, not a page to fetch, and a LAN
 * app has nowhere to host one.
 *
 * Three sources of failure are mapped here and nowhere else:
 *
 *   - `HttpProblem`, thrown by routes and the auth guard;
 *   - `DataError`, the expected refusals from `@shopquote/db` (not found,
 *     conflict, bad reference);
 *   - Fastify's own 4xx errors (malformed JSON, wrong content type, too big).
 *
 * Anything else is a defect: logged in full, answered with a 500 that says
 * nothing about the internals.
 */

import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';

import { DataError } from '@shopquote/db';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** One field-level complaint: where in the body, and what is wrong. */
export interface FieldError {
  /** RFC 6901 JSON Pointer into the request body, e.g. `/defaults/laborMarkup`. */
  pointer: string;
  detail: string;
}

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    /** The last segment of `type`: `not-found`, `validation`. */
    readonly slug: string,
    readonly title: string,
    readonly detail?: string,
    readonly extensions: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(detail ?? title);
    this.name = 'HttpProblem';
  }
}

export function pointerOf(path: readonly (string | number)[]): string {
  if (path.length === 0) return '';
  return `/${path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

export const problems = {
  unauthenticated: () =>
    new HttpProblem(
      401,
      'unauthenticated',
      'Sign in first',
      'This needs a signed-in session. Sessions last twelve hours from sign-in.',
    ),
  invalidCredentials: () =>
    new HttpProblem(401, 'invalid-credentials', 'Wrong username or password'),
  passwordChangeRequired: () =>
    new HttpProblem(
      403,
      'password-change-required',
      'Choose a new password first',
      'Someone else set this password. Change it with PUT /api/auth/password before anything else.',
    ),
  forbidden: (role: string, allowed: readonly string[]) =>
    new HttpProblem(
      403,
      'forbidden',
      'Your role cannot do that',
      `This needs ${allowed.join(' or ')}; you are signed in as ${role}.`,
    ),
  tooManyAttempts: (seconds: number) =>
    new HttpProblem(
      429,
      'too-many-attempts',
      'Too many failed sign-ins',
      `Try again in ${Math.ceil(seconds / 60)} minute${seconds > 60 ? 's' : ''}.`,
      { retryAfterSeconds: seconds },
      { 'retry-after': String(seconds) },
    ),
  notFound: (detail: string) => new HttpProblem(404, 'not-found', 'Not found', detail),
  /** One field wrong, found by a route rather than by a schema. */
  invalid: (pointer: string, detail: string) =>
    new HttpProblem(422, 'validation', 'The request did not validate', detail, {
      errors: [{ pointer, detail }] satisfies FieldError[],
    }),
  validation: (issues: readonly z.ZodIssue[], where: string) => {
    const errors: FieldError[] = issues.map((issue) => ({
      pointer: pointerOf(issue.path),
      detail: issue.message,
    }));
    const first = errors[0];
    const count = errors.length === 1 ? 'a problem' : `${errors.length} problems`;
    return new HttpProblem(
      422,
      'validation',
      'The request did not validate',
      `The ${where} has ${count}${first === undefined ? '.' : `, starting at "${first.pointer || '/'}": ${first.detail}`}`,
      { errors },
    );
  },
};

/** Validate with Zod at the boundary (CLAUDE.md), answering 422 on failure. */
export function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  where: 'body' | 'query string' | 'path' = 'body',
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw problems.validation(result.error.issues, where);
  return result.data;
}

export function toProblem(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof DataError) return fromDataError(error);
  if (isClientError(error)) return fromFastifyError(error);
  return new HttpProblem(
    500,
    'internal',
    'Something went wrong',
    'The server hit an error it did not expect. It has been logged.',
  );
}

function fromDataError(error: DataError): HttpProblem {
  const field = error.details?.['field'];
  const extensions =
    typeof field === 'string'
      ? { errors: [{ pointer: `/${field}`, detail: error.message }] satisfies FieldError[] }
      : {};
  switch (error.code) {
    case 'not-found':
      return new HttpProblem(404, 'not-found', 'Not found', error.message);
    case 'conflict':
      return new HttpProblem(
        409,
        'conflict',
        'That clashes with what is there',
        error.message,
        extensions,
      );
    case 'invalid-reference':
      return new HttpProblem(
        422,
        'invalid-reference',
        'A reference points at nothing',
        error.message,
        extensions,
      );
    case 'invalid':
      return new HttpProblem(
        422,
        'validation',
        'The request did not validate',
        error.message,
        extensions,
      );
  }
}

function isClientError(error: unknown): error is FastifyError & { statusCode: number } {
  if (!(error instanceof Error)) return false;
  const status = (error as FastifyError).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}

const CLIENT_ERRORS: Record<number, [slug: string, title: string]> = {
  400: ['bad-request', 'The request could not be read'],
  413: ['payload-too-large', 'The request body is too large'],
  415: ['unsupported-media-type', 'Send JSON'],
};

function fromFastifyError(error: FastifyError & { statusCode: number }): HttpProblem {
  const [slug, title] = CLIENT_ERRORS[error.statusCode] ?? ['bad-request', 'Bad request'];
  return new HttpProblem(error.statusCode, slug, title, error.message);
}

export function sendProblem(
  reply: FastifyReply,
  problem: HttpProblem,
  instance: string,
): FastifyReply {
  const body = {
    type: `urn:shopquote:problem:${problem.slug}`,
    title: problem.title,
    status: problem.status,
    ...(problem.detail === undefined ? {} : { detail: problem.detail }),
    instance,
    ...problem.extensions,
  };
  return reply
    .status(problem.status)
    .headers(problem.headers)
    .type(PROBLEM_CONTENT_TYPE)
    .send(JSON.stringify(body));
}

export function registerProblems(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    const problem = toProblem(error);
    if (problem.status >= 500) request.log.error({ err: error }, 'request failed');
    return sendProblem(reply, problem, request.url);
  });
  app.setNotFoundHandler((request, reply) =>
    sendProblem(
      reply,
      problems.notFound(`No route ${request.method} ${request.url}.`),
      request.url,
    ),
  );
}
