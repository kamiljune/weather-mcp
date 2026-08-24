import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/http/rateLimit.js';

describe('RateLimiter', () => {
  it('is disabled when the budget is zero', () => {
    const limiter = new RateLimiter(0);

    expect(limiter.enabled).toBe(false);
    for (let i = 0; i < 1000; i++) {
      expect(limiter.take('key').allowed).toBe(true);
    }
  });

  it('allows a full burst then refuses', () => {
    const limiter = new RateLimiter(5);
    const now = 1_000_000;

    for (let i = 0; i < 5; i++) {
      expect(limiter.take('key', now).allowed).toBe(true);
    }

    const refused = limiter.take('key', now);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('refills continuously over time', () => {
    const limiter = new RateLimiter(60); // one token per second
    const start = 1_000_000;

    for (let i = 0; i < 60; i++) {
      limiter.take('key', start);
    }
    expect(limiter.take('key', start).allowed).toBe(false);

    // One second later exactly one token is back.
    expect(limiter.take('key', start + 1000).allowed).toBe(true);
    expect(limiter.take('key', start + 1000).allowed).toBe(false);
  });

  it('never refills past the burst ceiling', () => {
    const limiter = new RateLimiter(3);
    const start = 1_000_000;

    limiter.take('key', start);
    // An hour of idling must not bank more than the ceiling.
    for (let i = 0; i < 3; i++) {
      expect(limiter.take('key', start + 3_600_000).allowed).toBe(true);
    }
    expect(limiter.take('key', start + 3_600_000).allowed).toBe(false);
  });

  it('meters each key separately', () => {
    const limiter = new RateLimiter(2);
    const now = 1_000_000;

    limiter.take('alice', now);
    limiter.take('alice', now);
    expect(limiter.take('alice', now).allowed).toBe(false);

    expect(limiter.take('bob', now).allowed).toBe(true);
  });
});
