import { describe, expect, it } from 'vitest';

import { lintSample } from './lint-sample.ts';

const FILE = 'src/core/sample.ts';

async function ruleIds(code: string, filePath = FILE): Promise<(string | null)[]> {
  return (await lintSample(code, filePath)).map((message) => message.ruleId);
}

describe('type-safety bans (ES §4)', () => {
  it('rejects any', async () => {
    expect(await ruleIds('export const x: any = 1;\n')).toEqual([
      '@typescript-eslint/no-explicit-any',
    ]);
  });

  it('rejects non-null assertions', async () => {
    expect(await ruleIds('export function f(x?: string): string {\n  return x!;\n}\n')).toEqual([
      '@typescript-eslint/no-non-null-assertion',
    ]);
  });

  it('rejects as casts and angle-bracket casts', async () => {
    expect(await ruleIds('export const x = 1 as unknown;\nexport const y = <unknown>2;\n')).toEqual(
      [
        '@typescript-eslint/consistent-type-assertions',
        '@typescript-eslint/consistent-type-assertions',
      ],
    );
  });

  it('allows as const', async () => {
    expect(await ruleIds("export const X = ['a', 'b'] as const;\n")).toEqual([]);
  });

  it('applies outside src/ too', async () => {
    expect(await ruleIds('export const x: any = 1;\n', 'scripts/sample.ts')).toEqual([
      '@typescript-eslint/no-explicit-any',
    ]);
    expect(await ruleIds('export const x: any = 1;\n', 'test/sample.test.ts')).toEqual([
      '@typescript-eslint/no-explicit-any',
    ]);
  });
});

describe('disable comments', () => {
  const BANNED = 'export const x: any = 1;\n';

  it('accepts a disable comment with a justification', async () => {
    const code = `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test\n${BANNED}`;
    expect(await ruleIds(code)).toEqual([]);
  });

  it('rejects a disable comment without a justification', async () => {
    const code = `// eslint-disable-next-line @typescript-eslint/no-explicit-any\n${BANNED}`;
    expect(await ruleIds(code)).toEqual(['@eslint-community/eslint-comments/require-description']);
  });

  it('rejects a disable comment that names no rule', async () => {
    const code = `/* eslint-disable -- test */\n${BANNED}`;
    expect(await ruleIds(code)).toEqual(['@eslint-community/eslint-comments/no-unlimited-disable']);
  });

  it('rejects a disable comment that suppresses nothing', async () => {
    const code =
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test\nexport const x = 1;\n';
    const messages = await lintSample(code, FILE);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatch(/Unused eslint-disable directive/);
  });
});
