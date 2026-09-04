/**
 * Per-key rate limiting for the HTTP transport.
 *
 * A fixed-capacity token bucket that refills continuously, so a caller may burst
 * up to the per-minute budget and then settles to a steady rate. In-memory and
 * per-process: it protects this instance and the free upstream APIs it depends
 * on from one runaway client, not from a distributed attacker.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until one token is available again; 0 when allowed. */
  retryAfterSeconds: number;
}

/** Buckets untouched for this long are dropped by the sweep. */
const IDLE_EVICTION_MS = 10 * 60 * 1000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  /**
   * @param perMinute Requests per minute per tenant. 0 disables limiting entirely.
   */
  constructor(private readonly perMinute: number) {
    this.refillPerMs = perMinute / 60000;
  }

  /** Whether this limiter enforces anything. */
  get enabled(): boolean {
    return this.perMinute > 0;
  }

  /**
   * Consume one token for a key.
   *
   * @param id Non-secret key identifier.
   */
  take(id: string, now: number = Date.now()): RateLimitDecision {
    if (!this.enabled) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const bucket = this.buckets.get(id) ?? { tokens: this.perMinute, updatedAt: now };
    const refilled = Math.min(
      this.perMinute,
      bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.refillPerMs
    );

    if (refilled < 1) {
      this.buckets.set(id, { tokens: refilled, updatedAt: now });
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - refilled) / this.refillPerMs / 1000))
      };
    }

    this.buckets.set(id, { tokens: refilled - 1, updatedAt: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Start periodic eviction of idle buckets. The timer is unref'd so it never
   * holds the process open.
   */
  startSweeping(): void {
    if (this.sweepTimer || !this.enabled) {
      return;
    }
    this.sweepTimer = setInterval(() => this.sweep(), IDLE_EVICTION_MS);
    this.sweepTimer.unref();
  }

  /** Stop the eviction timer. */
  stopSweeping(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private sweep(now: number = Date.now()): void {
    for (const [id, bucket] of this.buckets) {
      if (now - bucket.updatedAt > IDLE_EVICTION_MS) {
        this.buckets.delete(id);
      }
    }
  }
}
