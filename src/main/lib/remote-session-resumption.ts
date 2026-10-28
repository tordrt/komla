export interface RemoteSessionResumeGrant {
  token: string;
  /** The latest the grant could ever work, so the browser keeps it until then. */
  expiresAt: number;
}

interface RemoteSessionResumptionOptions {
  generateToken: () => Uint8Array;
  now: () => number;
  /** How long a grant stays usable after the connection that received it ends, read on each use. */
  ttlMs: () => number;
  /** How long silent resumption can continue after the last passkey verification. */
  maxAgeMs: number;
}

interface StoredGrant {
  deviceId: string;
  token: string;
  verifiedAt: number;
  /** When the connection holding the grant ended; null while it is open. */
  releasedAt: number | null;
}

/** In-memory, rotating grants used only to recover a recently verified browser tab. */
export class RemoteSessionResumptionStore {
  private readonly grants = new Map<string, StoredGrant>();

  constructor(private readonly options: RemoteSessionResumptionOptions) {}

  /**
   * Issues a grant to a connection that just authenticated. `verifiedAt` is
   * when the device last passed passkey verification: now for a passkey
   * login, or carried over from the grant a silent resume consumed.
   */
  issue(deviceId: string, verifiedAt = this.options.now()): RemoteSessionResumeGrant {
    this.pruneExpired();
    const bytes = this.options.generateToken();
    if (bytes.length !== 32) {
      throw new RangeError(`resume token must be 32 bytes, got ${bytes.length}`);
    }
    const token = Buffer.from(bytes).toString('base64url');
    this.grants.set(token, { deviceId, token, verifiedAt, releasedAt: null });
    return { token, expiresAt: verifiedAt + this.options.maxAgeMs };
  }

  /** Starts a grant's short window once the connection that received it ends. */
  release(token: string): void {
    const grant = this.grants.get(token);
    if (grant && grant.releasedAt === null) grant.releasedAt = this.options.now();
  }

  /**
   * When the device last passed passkey verification, if the grant is still
   * usable, without using it up: a sign-in that drops before it finishes
   * leaves the grant for the next attempt.
   */
  peek(deviceId: string, token: string): number | null {
    const grant = this.grants.get(token);
    if (!grant) return null;
    if (this.deadline(grant) <= this.options.now()) {
      this.grants.delete(token);
      return null;
    }
    return grant.deviceId === deviceId ? grant.verifiedAt : null;
  }

  /**
   * Redeems a grant once, returning when the device last passed passkey
   * verification. The connection that received it may still look open when
   * the phone's network dropped silently; the desktop ends that connection
   * once the redeeming one signs in.
   */
  consume(deviceId: string, token: string): number | null {
    const verifiedAt = this.peek(deviceId, token);
    if (verifiedAt !== null) this.grants.delete(token);
    return verifiedAt;
  }

  revokeDevice(deviceId: string): void {
    for (const [token, grant] of this.grants) {
      if (grant.deviceId === deviceId) this.grants.delete(token);
    }
  }

  revokeAll(): void {
    this.grants.clear();
  }

  private pruneExpired(): void {
    const now = this.options.now();
    for (const [token, grant] of this.grants) {
      if (this.deadline(grant) <= now) this.grants.delete(token);
    }
  }

  private deadline(grant: StoredGrant): number {
    const maxAge = grant.verifiedAt + this.options.maxAgeMs;
    return grant.releasedAt === null
      ? maxAge
      : Math.min(maxAge, grant.releasedAt + this.options.ttlMs());
  }
}
