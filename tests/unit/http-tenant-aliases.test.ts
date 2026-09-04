import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TenantAliases } from '../../src/http/tenantAliases.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('TenantAliases', () => {
  it('uses the Garmin slug by default and preserves an explicit legacy mapping', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weather-aliases-'));
    dirs.push(dir);
    const file = join(dir, 'aliases.json');
    writeFileSync(file, JSON.stringify({ slug_aliases: { user4: 'lihao' } }));
    const aliases = new TenantAliases(file);
    expect(aliases.resolve('kamil')).toBe('kamil');
    expect(aliases.resolve('user4')).toBe('lihao');
  });

  it('rejects unsafe path components', () => {
    expect(() => new TenantAliases().resolve('../escape')).toThrow(/invalid/);
  });
});

