import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../../src/core/errors.ts';
import {
  buildJobQuery,
  MANUAL_INPUT_NAMES,
  MANUAL_QUERY_MAX_CHARS,
  type ManualInputRejection,
  parseManualInputs,
  type RawManualInputs,
} from '../../src/core/manual-input.ts';
import { decodeManualJob, encodeManualJob, newManualJob } from '../../src/core/manual-job.ts';
import { utf8ByteLength } from '../../src/core/state-limits.ts';

const NOW = 1_790_000_000_000;
const AFTER_2H = Math.floor((NOW - 2 * 3_600_000) / 1000);
const AFTER_36H = Math.floor((NOW - 36 * 3_600_000) / 1000);

function raw(fields: Partial<RawManualInputs> = {}): RawManualInputs {
  return {
    query: undefined,
    timespan: undefined,
    applyMoves: undefined,
    replace: undefined,
    ...fields,
  };
}

function rejection(fields: Partial<RawManualInputs>): ManualInputRejection | undefined {
  const result = parseManualInputs(raw(fields), NOW);
  return result.ok ? undefined : result.kind;
}

describe('MANUAL_INPUT_NAMES', () => {
  it('lists the four inputs in order', () => {
    expect(MANUAL_INPUT_NAMES).toEqual([
      'MANUAL_QUERY',
      'MANUAL_TIMESPAN',
      'MANUAL_APPLY_MOVES',
      'MANUAL_REPLACE',
    ]);
  });
});

describe('parseManualInputs: the job query', () => {
  it.each([
    ['query only', { query: 'label:Receipts' }, 'label:Receipts'],
    ['timespan only', { timespan: '2h' }, `after:${String(AFTER_2H)}`],
    [
      'both',
      { query: 'label:Receipts', timespan: '2h' },
      `(label:Receipts) after:${String(AFTER_2H)}`,
    ],
    [
      'inner spaces, quotes, OR and parentheses kept verbatim',
      { query: '  from:(a@x.com OR b@x.com) "big deal"  -in:chats ' },
      'from:(a@x.com OR b@x.com) "big deal"  -in:chats',
    ],
    [
      'a blank query with a timespan',
      { query: '   ', timespan: '2h' },
      `after:${String(AFTER_2H)}`,
    ],
  ])('%s', (_name, fields, expected) => {
    const result = parseManualInputs(raw(fields), NOW);
    expect(result.ok && result.query).toBe(expected);
  });

  it('leaves timespan and after out without a timespan', () => {
    const result = parseManualInputs(raw({ query: 'in:inbox' }), NOW);
    expect(result).toEqual({ ok: true, query: 'in:inbox', applyMoves: false, replace: false });
    expect(result.ok && 'timespan' in result).toBe(false);
    expect(result.ok && 'after' in result).toBe(false);
  });

  it('gives the canonical timespan and the bound with a timespan', () => {
    const result = parseManualInputs(raw({ timespan: ' 36H ' }), NOW);
    expect(result).toEqual({
      ok: true,
      query: `after:${String(AFTER_36H)}`,
      applyMoves: false,
      replace: false,
      timespan: '36h',
      after: AFTER_36H,
    });
  });
});

describe('parseManualInputs: unset and blank', () => {
  it.each([
    ['every input unset', {}],
    ['a blank query', { query: '  ' }],
    ['blank everything', { query: '', timespan: ' ', applyMoves: '', replace: ' ' }],
  ])('%s is no_input', (_name, fields) => {
    expect(rejection(fields)).toBe('no_input');
  });
});

describe('parseManualInputs: the flags', () => {
  const flags = [
    ['applyMoves', 'invalid_apply_moves'],
    ['replace', 'invalid_replace'],
  ] as const;

  describe.each(flags)('%s', (name, reason) => {
    it.each([undefined, '', '  ', 'false', 'FALSE', ' False '])('%j is false', (value) => {
      const result = parseManualInputs(raw({ query: 'a', [name]: value }), NOW);
      expect(result.ok && result[name]).toBe(false);
    });

    it.each(['true', 'TRUE', ' True '])('%j is true', (value) => {
      const result = parseManualInputs(raw({ query: 'a', [name]: value }), NOW);
      expect(result.ok && result[name]).toBe(true);
    });

    it.each(['yes', '1', '0', 'on', 'treu', 'true false'])('%j is refused', (value) => {
      expect(rejection({ query: 'a', [name]: value })).toBe(reason);
    });
  });
});

describe('parseManualInputs: the query bounds', () => {
  it('accepts exactly 1,000 characters and refuses 1,001', () => {
    expect(rejection({ query: 'a'.repeat(MANUAL_QUERY_MAX_CHARS) })).toBeUndefined();
    expect(rejection({ query: 'a'.repeat(MANUAL_QUERY_MAX_CHARS + 1) })).toBe('query_too_long');
  });

  it('counts the trimmed value', () => {
    const padded = `  ${'a'.repeat(MANUAL_QUERY_MAX_CHARS)}\n\t `;
    expect(rejection({ query: padded })).toBeUndefined();
  });

  it.each([
    ['a tab', 'a\tb'],
    ['a line feed', 'a\nb'],
    ['a carriage return', 'a\rb'],
    ['U+0000', 'a\u0000b'],
    ['U+007F', 'a\u007fb'],
    ['U+0085', 'a\u0085b'],
    ['U+2028', 'a b'],
    ['U+2029', 'a b'],
    ['a lone high surrogate', 'a\ud83db'],
    ['a high surrogate at the end', 'a\ud83d'],
    ['a lone low surrogate', 'a\ude00b'],
  ])('refuses %s inside the value', (_name, query) => {
    expect(rejection({ query })).toBe('invalid_query');
  });

  it('trims a tab or a line break at either end', () => {
    const result = parseManualInputs(raw({ query: '\t\nlabel:a\n' }), NOW);
    expect(result.ok && result.query).toBe('label:a');
  });

  it.each([
    ['an emoji', 'label:\u{1f600}'],
    ['accented letters', 'from:Zoë café'],
  ])('accepts %s', (_name, query) => {
    const result = parseManualInputs(raw({ query }), NOW);
    expect(result.ok && result.query).toBe(query);
  });
});

describe('parseManualInputs: the order of the checks', () => {
  it.each([
    ['a bad query and a bad timespan', { query: 'a\tb', timespan: 'x' }, 'invalid_query'],
    [
      'a long query and a bad timespan',
      { query: 'a'.repeat(1001), timespan: 'x' },
      'query_too_long',
    ],
    ['a bad timespan and a bad flag', { timespan: '5m', applyMoves: 'yes' }, 'invalid_timespan'],
    ['a bad apply flag alone', { applyMoves: 'yes' }, 'invalid_apply_moves'],
    ['a bad replace flag alone', { replace: 'yes' }, 'invalid_replace'],
    ['both flags bad', { query: 'a', applyMoves: 'yes', replace: 'yes' }, 'invalid_apply_moves'],
  ] as const)('%s', (_name, fields, expected) => {
    expect(rejection(fields)).toBe(expected);
  });
});

describe('buildJobQuery', () => {
  it('builds the three forms', () => {
    expect(buildJobQuery('a b', undefined)).toBe('a b');
    expect(buildJobQuery(undefined, 7)).toBe('after:7');
    expect(buildJobQuery('a b', 7)).toBe('(a b) after:7');
  });

  it('throws with neither argument', () => {
    expect(() => buildJobQuery(undefined, undefined)).toThrow(InvalidArgumentError);
  });

  it('fits the stored job in the worst case', () => {
    const query = '€'.repeat(MANUAL_QUERY_MAX_CHARS);
    const result = parseManualInputs(raw({ query, timespan: '1h' }), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(utf8ByteLength(JSON.stringify(result.query))).toBeLessThan(3100);
    const job = newManualJob({ query: result.query, applyMoves: false, startedAt: NOW });
    expect(decodeManualJob(encodeManualJob(job))).toEqual(job);
  });
});
