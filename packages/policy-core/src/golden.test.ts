import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import inputJson from './test-fixtures/basic-routing.input.json';
import { compilePolicy } from './index.js';
import type { CompilerFormat, PolicyCompileInput } from './types.js';

const fixtureUrl = (name: string) => new URL(`./test-fixtures/${name}`, import.meta.url);

function fixture(): PolicyCompileInput {
  return structuredClone(inputJson) as PolicyCompileInput;
}

describe('policy compiler golden fixtures', () => {
  it.each([
    ['mihomo', 'basic-routing.mihomo.yaml'],
    ['sing-box', 'basic-routing.sing-box.json'],
    ['raw', 'basic-routing.raw.txt'],
  ] as const)('keeps the %s output byte-for-byte stable', (format, expectedFile) => {
    const expected = readFileSync(fixtureUrl(expectedFile), 'utf8');
    expect(compilePolicy(fixture(), format).output).toBe(expected);
  });

  it('produces parseable YAML and JSON golden outputs', () => {
    expect(parseYaml(compilePolicy(fixture(), 'mihomo').output)).toMatchObject({
      rules: [
        'DOMAIN,example.com,Primary Pool',
        'DOMAIN-SUFFIX,ads.example.com,REJECT',
        'MATCH,DIRECT',
      ],
    });
    expect(() => {
      JSON.parse(compilePolicy(fixture(), 'sing-box').output) as unknown;
    }).not.toThrow();
  });

  it.each(['mihomo', 'sing-box', 'raw'] as const)(
    'compiles the same input 100 times with an identical %s hash',
    (format: CompilerFormat) => {
      const hashes = Array.from({ length: 100 }, () =>
        createHash('sha256').update(compilePolicy(fixture(), format).output).digest('hex'),
      );
      expect(new Set(hashes).size).toBe(1);
    },
  );

  it('keeps adapter metadata out of public subscription content', () => {
    for (const format of ['mihomo', 'sing-box', 'raw'] as const) {
      const result = compilePolicy(fixture(), format);
      expect(result.metadata.adapter.adapterVersion).toBe('1.0.0');
      expect(result.metadata.adapter.validatedAgainst.length).toBeGreaterThan(0);
      expect(result.output).not.toContain('validatedAgainst');
      expect(result.output).not.toContain('adapterVersion');
    }
  });
});
