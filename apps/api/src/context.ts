import type { DatabaseHandle } from '@shopquote/db';

import type { LoginThrottle } from './auth/throttle.js';

/** What every route needs, built once by `buildServer()`. */
export interface AppContext {
  db: DatabaseHandle;
  /** The shop this server serves. v1 deploys one per database (§12 rule 4). */
  shopId: string;
  /** The clock. Sessions, the throttle and "today's prices" all read it, so a
   *  test can move time without waiting twelve hours. */
  now: () => Date;
  /** Mark the session cookie Secure. On behind HTTPS (§7). */
  secureCookies: boolean;
  throttle: LoginThrottle;
  /**
   * A real argon2id hash of nothing anyone knows. A login that names no user
   * is checked against it, so a wrong username costs what a wrong password
   * does and the response time tells an attacker neither.
   */
  decoyHash: () => Promise<string>;
}
