/**
 * The login throttle (§7: "rate-limit login").
 *
 * It counts *failed* sign-ins, not requests: the estimator who signs in and
 * out ten times a day is never slowed, and someone guessing is stopped after a
 * handful. Two limits, because they stop different things:
 *
 *   - per address and username — 5 failures in 15 minutes — stops a guesser
 *     working one account from one machine;
 *   - per address — 20 in 15 minutes — stops the same machine working through
 *     the shop's other accounts instead.
 *
 * There is deliberately no limit per username alone. On a shop LAN it would
 * let anyone lock the owner out by typing the owner's name wrong five times.
 *
 * The window runs from the first failure, and the counts live in memory. A
 * restart clears them; for five accounts behind argon2id that is a fair price
 * for not keeping a table of strangers' guesses.
 */

import { normalizeUsername } from '@shopquote/db';

export interface ThrottleLimits {
  perAccount: number;
  perAddress: number;
  windowMs: number;
}

export const DEFAULT_THROTTLE: ThrottleLimits = {
  perAccount: 5,
  perAddress: 20,
  windowMs: 15 * 60 * 1000,
};

interface Window {
  count: number;
  resetAt: number;
}

export class LoginThrottle {
  private readonly failures = new Map<string, Window>();
  private readonly limits: ThrottleLimits;

  constructor(limits: ThrottleLimits = DEFAULT_THROTTLE) {
    this.limits = limits;
  }

  /** Seconds until this address may try this username again; 0 for now. */
  retryAfterSeconds(address: string, username: string, now: Date): number {
    const t = now.getTime();
    let wait = 0;
    for (const [key, limit] of this.keys(address, username)) {
      const window = this.failures.get(key);
      if (window === undefined) continue;
      if (window.resetAt <= t) {
        this.failures.delete(key);
      } else if (window.count >= limit) {
        wait = Math.max(wait, Math.ceil((window.resetAt - t) / 1000));
      }
    }
    return wait;
  }

  recordFailure(address: string, username: string, now: Date): void {
    const t = now.getTime();
    for (const [key] of this.keys(address, username)) {
      const window = this.failures.get(key);
      if (window === undefined || window.resetAt <= t) {
        this.failures.set(key, { count: 1, resetAt: t + this.limits.windowMs });
      } else {
        window.count += 1;
      }
    }
    // A slow leak is still a leak: drop finished windows once there are many.
    if (this.failures.size > 10_000) {
      for (const [key, window] of this.failures) if (window.resetAt <= t) this.failures.delete(key);
    }
  }

  /** A good password clears that account's count from that address — not the
   *  address's count, which would let a guesser reset it with their own login. */
  recordSuccess(address: string, username: string): void {
    this.failures.delete(this.accountKey(address, username));
  }

  private keys(address: string, username: string): [string, number][] {
    return [
      [this.accountKey(address, username), this.limits.perAccount],
      [`address:${address}`, this.limits.perAddress],
    ];
  }

  private accountKey(address: string, username: string): string {
    return `account:${address}|${normalizeUsername(username)}`;
  }
}
