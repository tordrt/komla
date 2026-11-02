/**
 * Why a call failed: Komla's own error, such as `CAPABILITY_DISABLED` or `WORKSPACE_NOT_FOUND`
 * with the message it gives agents, or one of the SDK's:
 *
 * - `CAPABILITY_NOT_DECLARED`: the client didn't declare the capability the operation needs.
 * - `INVALID_CAPABILITY`: the client declared a capability Komla doesn't have.
 * - `KOMLA_NOT_RUNNING`: no Komla was found to connect to.
 * - `KOMLA_UNREACHABLE`: Komla was found but didn't answer, or for a call that changes nothing,
 *   not in time (10 seconds by default). A call that changes something may still have run, if
 *   the connection dropped after Komla had it.
 * - `UNEXPECTED_RESPONSE`: Komla answered without a result, as one too old for the route does,
 *   or its answer to a call that changes something broke off, so the call may have run.
 */
export class KomlaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The HTTP status Komla answered with, when it answered. */
    readonly status?: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'KomlaError';
  }
}
