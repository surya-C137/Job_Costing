/**
 * `/api/users` — accounts, for admins (§4 FR-6: "login, roles, password reset
 * by admin").
 *
 * A password an admin types for someone — a new account, a reset — is the
 * admin's, not the user's, so the account comes up `mustChangePassword` and
 * the user chooses their own at first sign-in. A reset also signs the user out
 * everywhere.
 */

import type { FastifyInstance } from 'fastify';

import {
  archiveUser,
  createUser,
  getUser,
  listUsers,
  passwordProblem,
  setPassword,
  updateUser,
} from '@shopquote/db';

import { actorOf, ADMIN_ONLY } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { parse, problems } from '../problem.js';
import { idParams, passwordResetBody, userCreateBody, userUpdateBody } from '../schemas.js';

export function userRoutes(ctx: AppContext) {
  return async (app: FastifyInstance): Promise<void> => {
    const admins = { config: { access: ADMIN_ONLY } };

    app.get('/', admins, async () => listUsers(ctx.db.db, ctx.shopId));

    app.post('/', admins, async (request, reply) => {
      const body = parse(userCreateBody, request.body);
      const problem = passwordProblem(body.password, body.username);
      if (problem !== null) throw problems.invalid('/password', problem);
      const user = await createUser(ctx.db, ctx.shopId, body, actorOf(request));
      return reply.code(201).header('location', `/api/users/${user.id}`).send(user);
    });

    app.put('/:id', admins, async (request) => {
      const { id } = parse(idParams, request.params, 'path');
      const changes = parse(userUpdateBody, request.body);
      return updateUser(ctx.db, ctx.shopId, id, changes, actorOf(request));
    });

    app.delete('/:id', admins, async (request, reply) => {
      const { id } = parse(idParams, request.params, 'path');
      archiveUser(ctx.db, ctx.shopId, id, actorOf(request));
      return reply.code(204).send();
    });

    app.post('/:id/password', admins, async (request, reply) => {
      const { id } = parse(idParams, request.params, 'path');
      const { newPassword } = parse(passwordResetBody, request.body);
      const user = getUser(ctx.db.db, ctx.shopId, id);
      if (user === undefined) throw problems.notFound(`No user ${id} in this shop.`);
      const problem = passwordProblem(newPassword, user.username);
      if (problem !== null) throw problems.invalid('/newPassword', problem);

      await setPassword(ctx.db, ctx.shopId, id, newPassword, {
        mustChangePassword: true,
        actor: actorOf(request),
        action: 'user.password.reset',
      });
      return reply.code(204).send();
    });
  };
}
