/**
 * Hot reload of the API key file.
 *
 * These tests drive ApiKeySource.reload() directly rather than waiting on the
 * watcher, so they stay deterministic and I/O-cheap — the watcher itself is
 * just fs.watchFile calling reload().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApiKeySource } from '../../src/http/apiKeySource.js';

const KEY_A = 'wx_alpha_key_aaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'wx_beta_key_bbbbbbbbbbbbbbbbbbbbbb';
const KEY_C = 'wx_gamma_key_cccccccccccccccccccc';

describe('ApiKeySource', () => {
  let dir: string;
  let keyFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weather-mcp-keys-'));
    keyFile = join(dir, 'keys.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function write(tenants: unknown): void {
    writeFileSync(keyFile, JSON.stringify({ tenants }), 'utf-8');
  }

  function source(): ApiKeySource {
    return new ApiKeySource({ filePath: keyFile, pollSeconds: 0 });
  }

  describe('from a key file', () => {
    it('loads tenants at construction', () => {
      write([{ id: 'kamil', keys: [KEY_A] }]);
      const keys = source();

      expect(keys.reloadable).toBe(true);
      expect(keys.current.verify(KEY_A)?.id).toBe('kamil');
    });

    it('picks up an added tenant without a restart', () => {
      write([{ id: 'kamil', keys: [KEY_A] }]);
      const keys = source();
      expect(keys.current.verify(KEY_B)).toBeNull();

      write([{ id: 'kamil', keys: [KEY_A] }, { id: 'alice', keys: [KEY_B] }]);

      expect(keys.reload()).toBe(true);
      expect(keys.current.verify(KEY_B)?.id).toBe('alice');
      // The existing tenant is undisturbed.
      expect(keys.current.verify(KEY_A)?.id).toBe('kamil');
    });

    it('revokes a removed tenant on reload', () => {
      write([{ id: 'kamil', keys: [KEY_A] }, { id: 'alice', keys: [KEY_B] }]);
      const keys = source();

      write([{ id: 'kamil', keys: [KEY_A] }]);

      expect(keys.reload()).toBe(true);
      expect(keys.current.verify(KEY_B)).toBeNull();
    });

    it('rotates a key while keeping the tenant identity', () => {
      write([{ id: 'kamil', keys: [KEY_A] }]);
      const keys = source();

      // Both keys valid during the overlap window...
      write([{ id: 'kamil', keys: [KEY_A, KEY_C] }]);
      keys.reload();
      expect(keys.current.verify(KEY_A)?.id).toBe('kamil');
      expect(keys.current.verify(KEY_C)?.id).toBe('kamil');

      // ...then the old one is dropped, and the identity is unchanged.
      write([{ id: 'kamil', keys: [KEY_C] }]);
      keys.reload();
      expect(keys.current.verify(KEY_A)).toBeNull();
      expect(keys.current.verify(KEY_C)?.id).toBe('kamil');
    });

    it('reports no change when the file is rewritten identically', () => {
      write([{ id: 'kamil', keys: [KEY_A] }]);
      const keys = source();

      write([{ id: 'kamil', keys: [KEY_A] }]);

      expect(keys.reload()).toBe(false);
    });

    it('keeps the previous key set when the file becomes invalid JSON', () => {
      write([{ id: 'kamil', keys: [KEY_A] }]);
      const keys = source();

      // A half-written file must never lock every caller out.
      writeFileSync(keyFile, '{ "tenants": [', 'utf-8');

      expect(keys.reload()).toBe(false);
      expect(keys.current.verify(KEY_A)?.id).toBe('kamil');
    });

    it('keeps the previous key set when the document is structurally wrong', () => {
      write([{ id: 'kamil', keys: [KEY_A] }]);
      const keys = source();

      write([{ id: 'alice', keys: [] }]);

      expect(keys.reload()).toBe(false);
      expect(keys.current.verify(KEY_A)?.id).toBe('kamil');
    });

    it('keeps the previous key set when the file is deleted', () => {
      write([{ id: 'kamil', keys: [KEY_A] }]);
      const keys = source();

      unlinkSync(keyFile);

      expect(keys.reload()).toBe(false);
      expect(keys.current.verify(KEY_A)?.id).toBe('kamil');
    });

    it('refuses to start when the file is missing or invalid', () => {
      expect(() => source()).toThrow();

      writeFileSync(keyFile, 'not json', 'utf-8');
      expect(() => source()).toThrow(/not valid JSON/);
    });

    it('never puts key material in a reload failure log', () => {
      write([{ id: 'kamil', keys: [KEY_A] }]);
      const keys = source();
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });

      // A distinctive value, so the assertion cannot be satisfied by accident
      // and cannot false-positive on a word in the message ("shorter than...").
      const rejectedKey = 'zq7v';
      writeFileSync(keyFile, JSON.stringify({ tenants: [{ id: 'a', keys: [rejectedKey] }] }), 'utf-8');
      keys.reload();

      const logged = errors.join('\n');
      expect(logged).toContain('API key reload failed');
      expect(logged).not.toContain(KEY_A);
      expect(logged).not.toContain(rejectedKey);
    });
  });

  describe('from WEATHER_API_KEYS', () => {
    it('loads the spec and reports itself as not reloadable', () => {
      const keys = new ApiKeySource({ spec: `kamil:${KEY_A}`, pollSeconds: 10 });

      expect(keys.reloadable).toBe(false);
      expect(keys.filePath).toBeUndefined();
      expect(keys.current.verify(KEY_A)?.id).toBe('kamil');
    });

    it('refuses to start with an empty spec', () => {
      expect(() => new ApiKeySource({ spec: '   ', pollSeconds: 0 })).toThrow();
      expect(() => new ApiKeySource({ pollSeconds: 0 })).toThrow(/No API keys/);
    });

    it('watching is a no-op without a file', () => {
      const keys = new ApiKeySource({ spec: `kamil:${KEY_A}`, pollSeconds: 10 });

      expect(() => { keys.startWatching(); keys.stopWatching(); }).not.toThrow();
    });
  });

  describe('watching a file', () => {
    it('reloads when the watched file changes', async () => {
      write([{ id: 'kamil', keys: [KEY_A] }]);
      const keys = new ApiKeySource({ filePath: keyFile, pollSeconds: 1 });
      keys.startWatching();

      try {
        write([{ id: 'kamil', keys: [KEY_A] }, { id: 'alice', keys: [KEY_B] }]);

        await vi.waitFor(
          () => expect(keys.current.verify(KEY_B)?.id).toBe('alice'),
          { timeout: 8000, interval: 100 }
        );
      } finally {
        keys.stopWatching();
      }
    }, 10000);
  });
});
