export interface RemoteSessionResumeGrant {
  token: string;
  /** The latest the grant could ever work, so the browser keeps it until then. */
  expiresAt: number;
}

/**
 * Who may redeem a grant: the browser whose key must sign the resume, and the passkey it signed
 * in with, which removing from the trusted devices revokes.
 */
export interface RemoteSessionResumeHolder {
  deviceId: string;
  /** SPKI-DER of the browser's key, standard base64. */
  devicePublicKey: string;
  credentialId: string;
}

/** A grant still usable: its holder, and when that browser last passed passkey verification. */
export interface RemoteSessionResumeUse {
  holder: RemoteSessionResumeHolder;
  verifiedAt: number;
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
  holder: RemoteSessionResumeHolder;
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
  issue(
    holder: RemoteSessionResumeHolder,
    verifiedAt = this.options.now()
  ): RemoteSessionResumeGrant {
    this.pruneExpired();
    const bytes = this.options.generateToken();
    if (bytes.length !== 32) {
      throw new RangeError(`resume token must be 32 bytes, got ${bytes.length}`);
    }
    const token = Buffer.from(bytes).toString('base64url');
    this.grants.set(token, { holder, token, verifiedAt, releasedAt: null });
    return { token, expiresAt: verifiedAt + this.options.maxAgeMs };
  }

  /** Starts a grant's short window once the connection that received it ends. */
  release(token: string): void {
    const grant = this.grants.get(token);
    if (grant && grant.releasedAt === null) grant.releasedAt = this.options.now();
  }

  /**
   * The grant's holder and when it last passed passkey verification, if the
   * grant is still usable by `deviceId`, without using it up: a sign-in that
   * drops before it finishes leaves the grant for the next attempt.
   */
  peek(deviceId: string, token: string): RemoteSessionResumeUse | null {
    const grant = this.grants.get(token);
    if (!grant) return null;
    if (this.deadline(grant) <= this.options.now()) {
      this.grants.delete(token);
      return null;
    }
    return grant.holder.deviceId === deviceId
      ? { holder: grant.holder, verifiedAt: grant.verifiedAt }
      : null;
  }

  /**
   * Redeems a grant once, returning when the device last passed passkey
   * verification. The connection that received it may still look open when
   * the phone's network dropped silently; the desktop ends that connection
   * once the redeeming one signs in.
   */
  consume(deviceId: string, token: string): RemoteSessionResumeUse | null {
    const use = this.peek(deviceId, token);
    if (use) this.grants.delete(token);
    return use;
  }

  /** Revokes the grants of every browser signed in with this passkey. */
  revokeCredential(credentialId: string): void {
    for (const [token, grant] of this.grants) {
      if (grant.holder.credentialId === credentialId) this.grants.delete(token);
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
