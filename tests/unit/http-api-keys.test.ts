import { describe, it, expect } from 'vitest';
import {
  ApiKeyRegistry,
  bearerToken,
  derivedTenantId,
  normalizeTenantId,
  parseKeySpec,
  parseKeysDocument
} from '../../src/http/apiKeys.js';

const KEY_A = 'wx_alpha_key_aaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'wx_beta_key_bbbbbbbbbbbbbbbbbbbbbb';
const KEY_C = 'wx_gamma_key_cccccccccccccccccccc';

function registry(spec: string): ApiKeyRegistry {
  return new ApiKeyRegistry(parseKeySpec(spec));
}

describe('normalizeTenantId', () => {
  it('lowercases and trims', () => {
    expect(normalizeTenantId('  Kamil  ', 'test')).toBe('kamil');
  });

  it('accepts dashes, underscores and digits', () => {
    expect(normalizeTenantId('team-a_2', 'test')).toBe('team-a_2');
  });

  it('rejects anything that could escape a directory', () => {
    // The id becomes a path segment, so this is the load-bearing guard.
    for (const bad of ['..', '../etc', 'a/b', 'a\\b', '/abs', 'a b', 'a.b', '', '   ']) {
      expect(() => normalizeTenantId(bad, 'test')).toThrow();
    }
  });

  it('rejects a non-string id', () => {
    expect(() => normalizeTenantId(undefined, 'test')).toThrow(/required/);
    expect(() => normalizeTenantId(42, 'test')).toThrow(/required/);
  });

  it('rejects an over-long id', () => {
    expect(() => normalizeTenantId('a'.repeat(65), 'test')).toThrow(/invalid/);
    expect(normalizeTenantId('a'.repeat(64), 'test')).toHaveLength(64);
  });
});

describe('parseKeySpec', () => {
  it('treats a labelled entry as a named tenant', () => {
    expect(parseKeySpec(`kamil:${KEY_A}`)).toEqual([
      { id: 'kamil', label: 'kamil', keys: [KEY_A] }
    ]);
  });

  it('groups entries that share a label into one tenant with several keys', () => {
    const tenants = parseKeySpec(`kamil:${KEY_A}, kamil:${KEY_B}, alice:${KEY_C}`);

    expect(tenants).toHaveLength(2);
    expect(tenants[0]).toMatchObject({ id: 'kamil', keys: [KEY_A, KEY_B] });
    expect(tenants[1]).toMatchObject({ id: 'alice', keys: [KEY_C] });
  });

  it('derives an id for an unlabelled key and warns about rotation', () => {
    const warnings: string[] = [];
    const tenants = parseKeySpec(KEY_A, message => warnings.push(message));

    expect(tenants[0].id).toBe(derivedTenantId(KEY_A));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/rotating it/);
    // The warning must not carry the key it is warning about.
    expect(warnings[0]).not.toContain(KEY_A);
  });

  it('ignores blank entries and surrounding whitespace', () => {
    expect(parseKeySpec(`  a:${KEY_A} , , b:${KEY_B}  `)).toHaveLength(2);
  });

  it('keeps colons that belong to the key itself', () => {
    const keyWithColon = 'wx:key:with:colons:aaaaaaaaaaaaaa';
    expect(parseKeySpec(`label:${keyWithColon}`)[0].keys).toEqual([keyWithColon]);
  });

  it('refuses a spec with no usable keys', () => {
    expect(() => parseKeySpec(' , , ')).toThrow(/no usable keys/);
  });

  it('refuses a label that is not a usable tenant id', () => {
    expect(() => parseKeySpec(`../evil:${KEY_A}`)).toThrow(/invalid/);
  });
});

describe('parseKeysDocument', () => {
  const valid = {
    tenants: [
      { id: 'kamil', label: 'Kamil', keys: [KEY_A, KEY_B] },
      { id: 'alice', keys: [KEY_C] }
    ]
  };

  it('parses a well-formed document', () => {
    expect(parseKeysDocument(valid)).toEqual([
      { id: 'kamil', label: 'Kamil', keys: [KEY_A, KEY_B] },
      { id: 'alice', keys: [KEY_C] }
    ]);
  });

  it('rejects a document that is not an object with tenants', () => {
    expect(() => parseKeysDocument(null)).toThrow(/must be a JSON object/);
    expect(() => parseKeysDocument([])).toThrow(/must be a JSON object/);
    expect(() => parseKeysDocument({})).toThrow(/"tenants" array/);
    expect(() => parseKeysDocument({ tenants: {} })).toThrow(/"tenants" array/);
    expect(() => parseKeysDocument({ tenants: [] })).toThrow(/empty/);
  });

  it('reports the position of a malformed tenant', () => {
    expect(() => parseKeysDocument({ tenants: [valid.tenants[0], 'nope'] }))
      .toThrow(/tenant #2 must be an object/);
  });

  it('requires a non-empty keys array', () => {
    expect(() => parseKeysDocument({ tenants: [{ id: 'a', keys: [] }] }))
      .toThrow(/non-empty "keys"/);
    expect(() => parseKeysDocument({ tenants: [{ id: 'a' }] }))
      .toThrow(/non-empty "keys"/);
  });

  it('rejects a non-string label', () => {
    expect(() => parseKeysDocument({ tenants: [{ id: 'a', label: 7, keys: [KEY_A] }] }))
      .toThrow(/non-string "label"/);
  });
});

describe('ApiKeyRegistry', () => {
  it('resolves every key of a tenant to the same identity', () => {
    const reg = registry(`kamil:${KEY_A}, kamil:${KEY_B}`);

    expect(reg.tenantCount).toBe(1);
    expect(reg.size).toBe(2);
    expect(reg.verify(KEY_A)).toEqual(reg.verify(KEY_B));
    expect(reg.verify(KEY_A)?.id).toBe('kamil');
  });

  it('keeps the tenant id independent of the key, so rotation preserves identity', () => {
    const before = registry(`kamil:${KEY_A}`);
    const after = registry(`kamil:${KEY_B}`);

    expect(after.verify(KEY_B)!.id).toBe(before.verify(KEY_A)!.id);
    // ...and the retired key stops working.
    expect(after.verify(KEY_A)).toBeNull();
  });

  it('rejects unknown, empty and absent keys', () => {
    const reg = registry(`kamil:${KEY_A}`);

    expect(reg.verify('not-a-real-key-000000000000')).toBeNull();
    expect(reg.verify('')).toBeNull();
    expect(reg.verify(undefined)).toBeNull();
    expect(reg.verify(null)).toBeNull();
  });

  it('rejects a near-miss rather than accepting a prefix', () => {
    const reg = registry(`kamil:${KEY_A}`);

    expect(reg.verify(KEY_A.slice(0, -1))).toBeNull();
    expect(reg.verify(`${KEY_A}x`)).toBeNull();
    expect(reg.verify(KEY_A.toUpperCase())).toBeNull();
  });

  it('refuses a key shorter than the minimum without echoing it', () => {
    const shortKey = 'tooshort';

    try {
      new ApiKeyRegistry([{ id: 'kamil', keys: [shortKey] }]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toMatch(/shorter than/);
      expect((error as Error).message).not.toContain(shortKey);
      expect((error as Error).message).toContain('kamil');
    }
  });

  it('refuses one key assigned to two tenants', () => {
    expect(() => new ApiKeyRegistry([
      { id: 'kamil', keys: [KEY_A] },
      { id: 'alice', keys: [KEY_A] }
    ])).toThrow(/assigned to both/);
  });

  it('refuses a duplicated tenant id', () => {
    expect(() => new ApiKeyRegistry([
      { id: 'kamil', keys: [KEY_A] },
      { id: 'Kamil', keys: [KEY_B] }
    ])).toThrow(/more than once/);
  });

  it('refuses an empty tenant list', () => {
    expect(() => new ApiKeyRegistry([])).toThrow(/no tenants/);
  });

  it('exposes non-secret identifiers only', () => {
    const reg = registry(`kamil:${KEY_A}, alice:${KEY_B}`);

    expect(reg.tenantIds).toEqual(['kamil', 'alice']);
    expect(reg.labels).toEqual(['kamil', 'alice']);
    expect(JSON.stringify(reg.tenantIds)).not.toContain(KEY_A);
  });

  describe('equals', () => {
    it('is true for the same tenants and keys', () => {
      expect(registry(`kamil:${KEY_A}`).equals(registry(`kamil:${KEY_A}`))).toBe(true);
    });

    it('is false when a key is added, removed or reassigned', () => {
      const base = registry(`kamil:${KEY_A}`);

      expect(base.equals(registry(`kamil:${KEY_A}, kamil:${KEY_B}`))).toBe(false);
      expect(base.equals(registry(`kamil:${KEY_B}`))).toBe(false);
      expect(base.equals(registry(`alice:${KEY_A}`))).toBe(false);
    });

    it('is false when only the label changed', () => {
      const a = new ApiKeyRegistry([{ id: 'kamil', label: 'Kamil', keys: [KEY_A] }]);
      const b = new ApiKeyRegistry([{ id: 'kamil', label: 'Kamil J', keys: [KEY_A] }]);

      expect(a.equals(b)).toBe(false);
    });
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
