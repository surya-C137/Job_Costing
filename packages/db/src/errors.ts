/**
 * The expected ways a write can be refused.
 *
 * Calc returns a typed `Result` for its expected conditions (CLAUDE.md); this
 * package throws a `DataError` for its own — a row that is not there, a name
 * already taken, a reference to something archived. The API maps `code` to an
 * HTTP status and a problem+json body. Nothing here knows about HTTP, and
 * anything that is *not* a `DataError` is a defect, reported as one.
 */

export type DataErrorCode =
  /** The row asked for does not exist in this shop, or has been archived. */
  | 'not-found'
  /** The write would collide with a live row — a duplicate name, the last admin. */
  | 'conflict'
  /** The body points at a row that is not a live row of this shop. */
  | 'invalid-reference'
  /** The body is well-formed but cannot be accepted as it stands. */
  | 'invalid';

export class DataError extends Error {
  constructor(
    readonly code: DataErrorCode,
    message: string,
    /** Structured detail for the client — which field, which rows. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DataError';
  }
}
