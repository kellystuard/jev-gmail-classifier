import { describe, expect, it } from 'vitest';

import { buildExclusionQuery, messageTimesMs } from '../../src/core/exclusion-query.ts';
import type { GmailMessage, GmailThread } from '../../src/core/gmail-types.ts';

/** 2026-09-25 06:13:20 UTC, in epoch milliseconds. Epoch seconds: 1790000000. */
const NOW = 1_790_000_000_000;
const DAY_MS = 86_400_000;

type MessageSpec = {
  /** Epoch milliseconds, as Gmail's `internalDate` string. Or the raw string. */
  readonly internal?: number | string;
  /** Values of `Date` headers. */
  readonly dates?: readonly string[];
  /** The header name, for the case check. */
  readonly headerName?: string;
  readonly labels?: readonly string[];
};

let nextId = 0;

function message(spec: MessageSpec): GmailMessage {
  nextId += 1;
  return {
    id: `m${String(nextId)}`,
    threadId: 't',
    ...(spec.labels ? { labelIds: spec.labels } : {}),
    ...(spec.internal !== undefined ? { internalDate: String(spec.internal) } : {}),
    payload: {
      headers: [
        { name: 'Subject', value: 'never read' },
        ...(spec.dates ?? []).map((value) => ({ name: spec.headerName ?? 'Date', value })),
      ],
    },
  };
}

function thread(...specs: MessageSpec[]): GmailThread {
  return { id: 't', messages: specs.map(message) };
}

describe('buildExclusionQuery', () => {
  type Row = {
    readonly name: string;
    readonly threads: readonly GmailThread[];
    readonly now?: number;
    readonly expected: string;
  };

  const rows: readonly Row[] = [
    {
      // Spike 23 A2: a window from the newest message misses a match in the oldest.
      name: 'the oldest message is the only match: lo comes from the oldest of messages 10 days apart',
      threads: [
        thread({ internal: 1_789_000_000_000 }, { internal: 1_789_000_000_000 + 10 * DAY_MS }),
      ],
      expected: '(from:x) after:1788913600 before:1790086400',
    },
    {
      name: 'several threads: lo is the earliest message of any thread, hi the latest of now and every message',
      threads: [
        thread({ internal: 1_789_500_000_000 }),
        thread({ internal: 1_788_000_000_000 }, { internal: 1_789_700_000_000 }),
        thread({ internal: 1_790_100_000_000 }),
      ],
      expected: '(from:x) after:1787913600 before:1790186400',
    },
    {
      name: 'several threads, all older than now: hi comes from now',
      threads: [thread({ internal: 1_789_500_000_000 }), thread({ internal: 1_788_000_000_000 })],
      expected: '(from:x) after:1787913600 before:1790086400',
    },
    {
      name: 'a Date header earlier than internalDate sets lo',
      // Sat, 1 Aug 2026 12:00:00 +0000 = 1785585600
      threads: [thread({ internal: 1_789_000_000_000, dates: ['Sat, 1 Aug 2026 12:00:00 +0000'] })],
      expected: '(from:x) after:1785499200 before:1790086400',
    },
    {
      name: 'a Date header later than internalDate sets hi',
      // Tue, 22 Sep 2026 12:00:00 +0000 = 1790078400, after now
      threads: [
        thread({ internal: 1_789_000_000_000, dates: ['Tue, 22 Sep 2026 12:00:00 +0000'] }),
      ],
      expected: '(from:x) after:1788913600 before:1790164800',
    },
    {
      name: 'the upper bound comes from now when every message is older',
      threads: [thread({ internal: 1_700_000_000_000 })],
      expected: '(from:x) after:1699913600 before:1790086400',
    },
    {
      // Spike 23 C2 (an upload with receivedTime): the index time is between the
      // reported internalDate (10 days old) and now. SD §14.
      name: 'a message indexed later than its internalDate is covered by hi = now + 1 day',
      threads: [thread({ internal: NOW - 10 * DAY_MS })],
      expected: '(from:x) after:1789049600 before:1790086400',
    },
    {
      name: 'a future Date header (a year ahead) extends hi past now + 1 day',
      // Wed, 29 Sep 2027 00:00:00 +0000 = 1822176000
      threads: [
        thread({ internal: 1_789_000_000_000, dates: ['Wed, 29 Sep 2027 00:00:00 +0000'] }),
      ],
      expected: '(from:x) after:1788913600 before:1822262400',
    },
    {
      name: 'an unparseable Date header falls back to internalDate',
      threads: [thread({ internal: 1_789_000_000_000, dates: ['not a date'] })],
      expected: '(from:x) after:1788913600 before:1790086400',
    },
    {
      name: 'a Date header with a trailing comment parses',
      threads: [thread({ dates: ['Tue, 22 Sep 2026 12:00:00 +0000 (UTC)'] })],
      expected: '(from:x) after:1789992000 before:1790164800',
    },
    {
      name: 'a lower-case date header name counts',
      threads: [
        thread({
          internal: 1_789_000_000_000,
          dates: ['Sat, 1 Aug 2026 12:00:00 +0000'],
          headerName: 'date',
        }),
      ],
      expected: '(from:x) after:1785499200 before:1790086400',
    },
    {
      name: 'an upper-case DATE header name counts',
      threads: [
        thread({
          internal: 1_789_000_000_000,
          dates: ['Sat, 1 Aug 2026 12:00:00 +0000'],
          headerName: 'DATE',
        }),
      ],
      expected: '(from:x) after:1785499200 before:1790086400',
    },
    {
      name: 'a message in TRASH counts toward lo',
      threads: [
        thread({ internal: 1_789_500_000_000 }, { internal: 1_788_000_000_000, labels: ['TRASH'] }),
      ],
      expected: '(from:x) after:1787913600 before:1790086400',
    },
    {
      name: 'a message in SPAM counts toward hi',
      threads: [
        thread({ internal: 1_789_500_000_000 }, { internal: 1_790_100_000_000, labels: ['SPAM'] }),
      ],
      expected: '(from:x) after:1789413600 before:1790186400',
    },
    {
      name: 'a DRAFT counts toward lo',
      threads: [
        thread({ internal: 1_789_500_000_000 }, { internal: 1_787_000_000_000, labels: ['DRAFT'] }),
      ],
      expected: '(from:x) after:1786913600 before:1790086400',
    },
    {
      name: 'sub-second times: lo floors and hi rounds up',
      // internalDate 1790078400.999 s is after now, so it decides hi.
      threads: [thread({ internal: '1790078400999' })],
      expected: '(from:x) after:1789992000 before:1790164801',
    },
    {
      name: 'sub-second now: hi rounds up',
      threads: [thread({ internal: 1_700_000_000_000 })],
      now: 1_790_000_000_001,
      expected: '(from:x) after:1699913600 before:1790086401',
    },
    {
      name: 'a message with neither internalDate nor Date header: no after:',
      threads: [thread({})],
      expected: '(from:x) before:1790086400',
    },
    {
      name: 'a message with no usable time among dated ones: no after:',
      threads: [thread({ internal: 1_789_000_000_000 }), thread({})],
      expected: '(from:x) before:1790086400',
    },
    {
      name: 'a message with no headers at all and no internalDate: no after:',
      threads: [{ id: 't', messages: [{ id: 'm', threadId: 't' }] }],
      expected: '(from:x) before:1790086400',
    },
    {
      name: 'an internalDate that is not decimal digits does not count',
      threads: [
        thread({ internal: '12.5' }),
        thread({ internal: '-5' }),
        thread({ internal: '1e12' }),
        thread({ internal: '' }),
        thread({ internal: '12345678901234567890' }),
      ],
      expected: '(from:x) before:1790086400',
    },
    {
      name: 'an unparseable Date header and no internalDate: no after:',
      threads: [thread({ dates: ['not a date'] })],
      expected: '(from:x) before:1790086400',
    },
    {
      name: 'a Date header before 1970: no after:',
      // Wed, 31 Dec 1969 12:00:00 +0000 = -43200
      threads: [
        thread({ internal: 1_789_000_000_000, dates: ['Wed, 31 Dec 1969 12:00:00 +0000'] }),
      ],
      expected: '(from:x) before:1790086400',
    },
    {
      name: 'a time of exactly 1 day since the epoch makes lo 0: no after:',
      threads: [thread({ internal: 86_400_000 })],
      expected: '(from:x) before:1790086400',
    },
    {
      name: 'a time of 1 day and 1 second since the epoch makes lo 1: after:1',
      threads: [thread({ internal: 86_401_000 })],
      expected: '(from:x) after:1 before:1790086400',
    },
    {
      name: 'a full-format thread works (only headers and internalDate are read)',
      threads: [
        {
          id: 't',
          messages: [
            {
              id: 'm',
              threadId: 't',
              internalDate: '1789000000000',
              snippet: 'ignored',
              payload: {
                mimeType: 'text/plain',
                headers: [{ name: 'Date', value: 'Sat, 1 Aug 2026 12:00:00 +0000' }],
                body: { size: 3, data: [97, 98, 99] },
              },
            },
          ],
        },
      ],
      expected: '(from:x) after:1785499200 before:1790086400',
    },
    {
      name: 'the one-thread case (the per-thread fallback)',
      threads: [thread({ internal: 1_789_000_000_000 }, { internal: 1_789_200_000_000 })],
      expected: '(from:x) after:1788913600 before:1790086400',
    },
    {
      name: 'a thread with no messages next to one with messages is ignored',
      threads: [{ id: 'empty' }, thread({ internal: 1_789_000_000_000 })],
      expected: '(from:x) after:1788913600 before:1790086400',
    },
  ];

  it.each(rows)('$name', ({ threads, now, expected }) => {
    expect(buildExclusionQuery('from:x', threads, now ?? NOW)).toBe(expected);
  });

  it('covers an index time between internalDate and now (SD §14)', () => {
    const query = buildExclusionQuery('from:x', [thread({ internal: NOW - 10 * DAY_MS })], NOW);
    const [, lo, hi] = /after:(\d+) before:(\d+)$/.exec(query) ?? [];
    const indexedAt = (NOW - 3 * DAY_MS) / 1000;
    expect(Number(lo)).toBeLessThanOrEqual(indexedAt);
    expect(Number(hi)).toBeGreaterThanOrEqual(indexedAt);
    expect(Number(hi)).toBeGreaterThanOrEqual(NOW / 1000 + 86_400);
  });

  describe('the user query', () => {
    const t = [thread({ internal: 1_789_000_000_000 })];
    const window = ' after:1788913600 before:1790086400';

    it.each([
      ['a plain term', 'from:boss@example.com'],
      ['OR', 'a OR b'],
      ['a nested group', 'from:x OR (from:y subject:z)'],
      ['braces', '{from:x label:y}'],
      ['a quoted label name with spaces', 'label:"Work Stuff" OR label:"Home & Away"'],
      ['a negated term', '-from:newsletter'],
      ['a term with a dash after another term', 'a -b'],
      ['leading and trailing spaces (never trimmed)', '  from:x  '],
      ['unbalanced parentheses (never parsed)', 'from:x) OR (from:y'],
    ])('goes in one pair of parentheses, unchanged: %s', (_name, query) => {
      expect(buildExclusionQuery(query, t, NOW)).toBe(`(${query})${window}`);
    });
  });

  describe('errors', () => {
    it('throws with no threads', () => {
      expect(() => buildExclusionQuery('from:x', [], NOW)).toThrow(Error);
    });

    it.each([
      ['one thread with no messages array', [{ id: 't' }]],
      ['one thread with an empty messages array', [{ id: 't', messages: [] }]],
      ['several threads, none with messages', [{ id: 'a' }, { id: 'b', messages: [] }]],
    ])('throws with %s', (_name, threads) => {
      expect(() => buildExclusionQuery('from:x', threads, NOW)).toThrow(Error);
    });

    it.each([
      ['NaN', NaN],
      ['Infinity', Infinity],
    ])('throws when now is %s', (_name, now) => {
      expect(() => buildExclusionQuery('from:x', [thread({ internal: 1 })], now)).toThrow(Error);
    });
  });
});

describe('messageTimesMs', () => {
  const cases: readonly (readonly [string, MessageSpec, readonly number[]])[] = [
    ['internalDate only', { internal: 1_789_000_000_000 }, [1_789_000_000_000]],
    [
      'internalDate and a Date header',
      { internal: 1_789_000_000_000, dates: ['Tue, 22 Sep 2026 12:00:00 +0000'] },
      [1_789_000_000_000, 1_790_078_400_000],
    ],
    ['a Date header only', { dates: ['Tue, 22 Sep 2026 12:00:00 +0000'] }, [1_790_078_400_000]],
    [
      'two Date headers',
      { dates: ['Tue, 22 Sep 2026 12:00:00 +0000', 'Sat, 1 Aug 2026 12:00:00 +0000'] },
      [1_790_078_400_000, 1_785_585_600_000],
    ],
    ['an unparseable Date header', { internal: 5, dates: ['not a date'] }, [5]],
    ['nothing', {}, []],
    ['a non-numeric internalDate', { internal: 'abc' }, []],
    ['an unsafe-integer internalDate', { internal: '99999999999999999999' }, []],
  ];

  it.each(cases)('returns %s', (_name, spec, expected) => {
    expect(messageTimesMs(message(spec))).toEqual(expected);
  });
});
