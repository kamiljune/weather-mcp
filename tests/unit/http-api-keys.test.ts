import { describe, it, expect } from 'vitest';
import { ApiKeyRegistry, bearerToken } from '../../src/http/apiKeys.js';

const KEY_A = 'wx_alpha_key_aaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'wx_beta_key_bbbbbbbbbbbbbbbbbbbbbb';

describe('ApiKeyRegistry', () => {
  it('accepts a single unlabelled key', () => {
    const registry = new ApiKeyRegistry(KEY_A);

    expect(registry.size).toBe(1);
    expect(registry.verify(KEY_A)).not.toBeNull();
  });

  it('parses labelled entries and exposes the labels', () => {
    const registry = new ApiKeyRegistry(`alice:${KEY_A}, bob:${KEY_B}`);

    expect(registry.size).toBe(2);
    expect(registry.labels).toEqual(['alice', 'bob']);
    expect(registry.verify(KEY_A)?.label).toBe('alice');
    expect(registry.verify(KEY_B)?.label).toBe('bob');
  });

  it('gives each key a distinct, stable, non-secret id', () => {
    const first = new ApiKeyRegistry(`alice:${KEY_A}, bob:${KEY_B}`);
    const second = new ApiKeyRegistry(`renamed:${KEY_A}`);

    const idA = first.verify(KEY_A)!.id;
    const idB = first.verify(KEY_B)!.id;

    expect(idA).not.toBe(idB);
    // Stable across processes and independent of the label, so saved locations survive restarts.
    expect(second.verify(KEY_A)!.id).toBe(idA);
    // The id is a hash prefix, never key material.
    expect(idA).toMatch(/^[0-9a-f]{12}$/);
    expect(KEY_A).not.toContain(idA);
  });

  it('rejects unknown, empty and absent keys', () => {
    const registry = new ApiKeyRegistry(KEY_A);

    expect(registry.verify('not-a-real-key-000000000000')).toBeNull();
    expect(registry.verify('')).toBeNull();
    expect(registry.verify(undefined)).toBeNull();
    expect(registry.verify(null)).toBeNull();
  });

  it('rejects a near-miss rather than accepting a prefix', () => {
    const registry = new ApiKeyRegistry(KEY_A);

    expect(registry.verify(KEY_A.slice(0, -1))).toBeNull();
    expect(registry.verify(`${KEY_A}x`)).toBeNull();
    expect(registry.verify(KEY_A.toUpperCase())).toBeNull();
  });

  it('ignores blank entries and surrounding whitespace', () => {
    const registry = new ApiKeyRegistry(`  ${KEY_A} , , ${KEY_B}  `);

    expect(registry.size).toBe(2);
    expect(registry.verify(KEY_A)).not.toBeNull();
  });

  it('keeps colons that belong to the key itself', () => {
    const keyWithColon = 'wx:key:with:colons:aaaaaaaaaaaaaa';
    const registry = new ApiKeyRegistry(`label:${keyWithColon}`);

    expect(registry.verify(keyWithColon)?.label).toBe('label');
  });

  it('refuses a key shorter than the minimum without echoing it', () => {
    const shortKey = 'tooshort';

    expect(() => new ApiKeyRegistry(`alice:${shortKey}`)).toThrow(/shorter than/);
    try {
      new ApiKeyRegistry(`alice:${shortKey}`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(shortKey);
      expect((error as Error).message).toContain('alice');
    }
  });

  it('refuses a spec with no usable keys', () => {
    expect(() => new ApiKeyRegistry(' , , ')).toThrow(/no usable keys/);
  });
});

describe('bearerToken', () => {
  it('extracts a bearer token case-insensitively', () => {
    expect(bearerToken(`Bearer ${KEY_A}`)).toBe(KEY_A);
    expect(bearerToken(`bearer ${KEY_A}`)).toBe(KEY_A);
    expect(bearerToken(`  Bearer   ${KEY_A}  `)).toBe(KEY_A);
  });

  it('takes the first value when the header repeats', () => {
    expect(bearerToken([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`])).toBe(KEY_A);
  });

  it('returns null for a missing or non-bearer header', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('Basic abc123')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('')).toBeNull();
  });
});
