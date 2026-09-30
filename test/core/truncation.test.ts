import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../../src/core/errors.ts';
import type { JevStateMessage } from '../../src/core/jev-state.ts';
import { estimateStateTokens, JEV_LIMIT_TOKENS } from '../../src/core/token-estimate.ts';
import { truncateState } from '../../src/core/truncation.ts';

/** The reserve that makes `state` fit exactly: its estimate plus the reserve is the limit. */
function reserveToFit(state: readonly JevStateMessage[]): number {
  return JEV_LIMIT_TOKENS - estimateStateTokens(state);
}

/** A result's estimate plus the reserve is within the limit. */
function expectFits(state: readonly JevStateMessage[], reserved: number): void {
  expect(estimateStateTokens(state) + reserved).toBeLessThanOrEqual(JEV_LIMIT_TOKENS);
}

/** The UTF-16 length of every value in `state`. */
function textLength(state: readonly JevStateMessage[]): number {
  return state.reduce(
    (sum, m) => sum + Object.values(m).reduce((n: number, v: string) => n + v.length, 0),
    0,
  );
}

function headers(n: number): JevStateMessage {
  return { from: `sender${String(n)}@example.com`, subject: `Message ${String(n)}` };
}

function msg(n: number, body = `Body of message ${String(n)}. `.repeat(20)): JevStateMessage {
  return { ...headers(n), body };
}

/** Deep-freezes a state, so a mutation throws. */
function frozen(state: JevStateMessage[]): readonly JevStateMessage[] {
  for (const message of state) Object.freeze(message);
  return Object.freeze(state);
}

describe('truncateState: fits already', () => {
  it('an empty state gives {state: []} and no stats', () => {
    expect(truncateState([], 1300)).toEqual({ state: [] });
  });

  const state = [msg(3), msg(2), msg(1)];
  it.each([
    ['just under the limit', reserveToFit(state) - 1],
    ['exactly at the limit', reserveToFit(state)],
    ['with no reserve', 0],
  ])('%s: a copy of the input, no truncated key', (_, reserved) => {
    const result = truncateState(state, reserved);
    expect(result).toEqual({ state });
    expect(result).not.toHaveProperty('truncated');
    expect(result.state).not.toBe(state);
    expect(result.state[0]).not.toBe(state[0]);
  });

  it('one token over the limit cuts something', () => {
    const result = truncateState(state, reserveToFit(state) + 1);
    expect(result.truncated).toBeDefined();
    expectFits(result.state, reserveToFit(state) + 1);
  });
});

describe('truncateState: the order', () => {
  const newest = msg(3);
  const middle = msg(2);
  const oldest = msg(1);
  const state = frozen([newest, middle, oldest]);
  const bodyLength = (m: JevStateMessage): number => m.body?.length ?? 0;

  it('step 1: the oldest body goes first, and the next oldest keeps its body', () => {
    const target = [newest, middle, headers(1)];
    const result = truncateState(state, reserveToFit(target));
    expect(result).toEqual({
      state: target,
      truncated: { messagesDropped: 0, bodiesDropped: 1, charsDropped: bodyLength(oldest) },
    });
  });

  it('step 1: then the next oldest body, never the newest', () => {
    const target = [newest, headers(2), headers(1)];
    const result = truncateState(state, reserveToFit(target));
    expect(result).toEqual({
      state: target,
      truncated: {
        messagesDropped: 0,
        bodiesDropped: 2,
        charsDropped: bodyLength(oldest) + bodyLength(middle),
      },
    });
  });

  it('step 2: the oldest message goes, its body counted once', () => {
    const target = [newest, headers(2)];
    const result = truncateState(state, reserveToFit(target));
    const oldestHeaders = (oldest.from?.length ?? 0) + (oldest.subject?.length ?? 0);
    expect(result).toEqual({
      state: target,
      truncated: {
        messagesDropped: 1,
        bodiesDropped: 1,
        charsDropped: bodyLength(oldest) + oldestHeaders + bodyLength(middle),
      },
    });
  });

  it('step 2: down to the newest message alone', () => {
    const target = [newest];
    const result = truncateState(state, reserveToFit(target));
    expect(result.state).toEqual(target);
    expect(result.truncated).toMatchObject({ messagesDropped: 2, bodiesDropped: 0 });
  });

  it('step 3: the newest body is cut from the end to a prefix that fits exactly', () => {
    const body = newest.body ?? '';
    const target = [{ ...headers(3), body: body.slice(0, 123) }];
    const result = truncateState(state, reserveToFit(target));
    expect(result.state).toEqual(target);
    expect(result.truncated).toEqual({
      messagesDropped: 2,
      bodiesDropped: 0,
      charsDropped: textLength([middle, oldest]) + body.length - 123,
    });
  });

  it('step 3: the body is removed when no prefix fits', () => {
    const target = [headers(3)];
    const result = truncateState(state, reserveToFit(target));
    expect(result.state).toEqual(target);
    expect(result.truncated).toMatchObject({ messagesDropped: 2, bodiesDropped: 1 });
  });
});

describe('truncateState: step 4, the newest headers', () => {
  const to = 't'.repeat(500);
  const subject = 's'.repeat(1000);
  const state = frozen([{ from: 'a@example.com', to, subject, body: 'Hello' }]);

  it('the longest header is cut first, just enough', () => {
    const target = [{ from: 'a@example.com', to, subject: subject.slice(0, 700) }];
    const result = truncateState(state, reserveToFit(target));
    expect(result).toEqual({
      state: target,
      truncated: { messagesDropped: 0, bodiesDropped: 1, charsDropped: 5 + 300 },
    });
  });

  it('down to the next longest, then both', () => {
    const target = [
      { from: 'a@example.com', to: to.slice(0, 400), subject: subject.slice(0, 400) },
    ];
    const result = truncateState(state, reserveToFit(target));
    expect(result).toEqual({
      state: target,
      truncated: { messagesDropped: 0, bodiesDropped: 1, charsDropped: 5 + 100 + 600 },
    });
  });

  it('a tie goes to the first key in map order', () => {
    const target = [
      { from: 'a@example.com', to: to.slice(0, 400), subject: subject.slice(0, 401) },
    ];
    const result = truncateState(state, reserveToFit(target));
    expect(result.state).toEqual(target);
  });

  it('a header cut to empty is removed with its key', () => {
    const small = frozen([{ from: 'xxx', subject: 'yyy' }]);
    const target = [{ subject: 'y' }];
    const result = truncateState(small, reserveToFit(target));
    expect(result).toEqual({
      state: target,
      truncated: { messagesDropped: 0, bodiesDropped: 0, charsDropped: 5 },
    });
    expect(result.state[0]).not.toHaveProperty('from');
  });

  it('the newest message is never dropped, even when the reserve exceeds the limit', () => {
    const result = truncateState([msg(2), msg(1)], JEV_LIMIT_TOKENS * 2);
    expect(result.state).toEqual([{}]);
    expect(result.truncated).toMatchObject({ messagesDropped: 1, bodiesDropped: 1 });
    expect(result.truncated?.charsDropped).toBe(textLength([msg(2), msg(1)]));
  });

  it('an empty message that still doesn’t fit is left alone, with no stats', () => {
    expect(truncateState([{}], JEV_LIMIT_TOKENS)).toEqual({ state: [{}] });
  });
});

describe('truncateState: cuts', () => {
  const emoji = '😀'.repeat(100);
  const base = [{ subject: 'Emoji' }];
  const minReserve = reserveToFit([{ subject: 'Emoji', body: emoji }]) + 1;

  it('never splits a surrogate pair, and keeps the longest whole prefix', () => {
    for (let reserved = minReserve; reserved < reserveToFit(base); reserved++) {
      const [result] = truncateState([{ subject: 'Emoji', body: emoji }], reserved).state;
      const body = result?.body ?? '';
      expect(body.length % 2).toBe(0);
      expect(emoji.startsWith(body)).toBe(true);
      expectFits([result ?? {}], reserved);
      expect(
        estimateStateTokens([{ subject: 'Emoji', body: emoji.slice(0, body.length + 2) }]) +
          reserved,
      ).toBeGreaterThan(JEV_LIMIT_TOKENS);
    }
  });

  it('never splits a surrogate pair in a header', () => {
    const subject = '👍🏽'.repeat(50);
    for (
      let reserved = reserveToFit([{ subject }]) + 1;
      reserved < reserveToFit([{}]);
      reserved += 3
    ) {
      const [result] = truncateState([{ subject }], reserved).state;
      const cut = result?.subject ?? '';
      expect(cut.length % 2).toBe(0);
      expect(subject.startsWith(cut)).toBe(true);
    }
  });

  it('measures escapes: a body of quotes and newlines fits once serialized', () => {
    const body = '"\n\\'.repeat(3000);
    const state = [{ subject: 'Escapes', body }];
    for (const reserved of [reserveToFit(state) + 1, 20_000, 30_000]) {
      const [result] = truncateState(state, reserved).state;
      const kept = result?.body ?? '';
      expect(body.startsWith(kept)).toBe(true);
      expectFits([result ?? {}], reserved);
      expect(
        estimateStateTokens([{ subject: 'Escapes', body: body.slice(0, kept.length + 1) }]) +
          reserved,
      ).toBeGreaterThan(JEV_LIMIT_TOKENS);
    }
  });
});

describe('truncateState: purity', () => {
  it('doesn’t mutate the input and keeps the key order', () => {
    const input = frozen([
      { from: 'a', to: 'b', subject: 'c', date: 'd', body: 'x'.repeat(40_000) },
      { from: 'e', subject: 'f', listId: 'g', body: 'y'.repeat(10) },
    ]);
    const copy = structuredClone(input);
    const result = truncateState(input, 1300);
    expect(input).toEqual(copy);
    expect(result.state.map((m) => Object.keys(m))).toEqual([
      ['from', 'to', 'subject', 'date', 'body'],
    ]);
  });
});

describe('truncateState: invalid reserve', () => {
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'throws InvalidArgumentError for %s',
    (reserved) => {
      expect(() => truncateState([msg(1)], reserved)).toThrow(InvalidArgumentError);
    },
  );

  it('names the argument', () => {
    try {
      truncateState([], -1);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(error).toMatchObject({ argument: 'reservedTokens', reason: 'negative' });
    }
  });
});

describe('truncateState: performance', () => {
  it('a 1,000-message thread finishes quickly', () => {
    const state = Array.from({ length: 1000 }, (_, i) => msg(1000 - i));
    const started = performance.now();
    const result = truncateState(state, 1300);
    expect(performance.now() - started).toBeLessThan(1000);
    expectFits(result.state, 1300);
    expect(result.state[0]).toEqual(state[0]);
  });

  it('a 1 MB newest body finishes quickly', () => {
    const body = 'All work and no play. \n'.repeat(45_000);
    const started = performance.now();
    const result = truncateState([{ subject: 'Big', body }], 1300);
    expect(performance.now() - started).toBeLessThan(1000);
    expectFits(result.state, 1300);
    expect(body.startsWith(result.state[0]?.body ?? '')).toBe(true);
  });

  it('a 1 MB header finishes quickly', () => {
    const started = performance.now();
    const result = truncateState([{ to: 'x'.repeat(500_000), cc: 'y'.repeat(500_000) }], 1300);
    expect(performance.now() - started).toBeLessThan(1000);
    expectFits(result.state, 1300);
  });
});

describe('truncateState: invariants over generated states', () => {
  /** mulberry32: a small seeded PRNG, so the cases are the same on every run. */
  function prng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pieces = ['word ', '"', '\n', 'é', '中', '😀', '\\', '\t', 'https://example.com/?a=1 '];
  const endsOnHigh = (s: string): boolean => /[\ud800-\udbff]$/.test(s);

  it('always fits (or is [{}]), keeps the newest, cuts only suffixes and counts every cut', () => {
    const random = prng(84);
    const text = (max: number): string => {
      let out = '';
      // Never blank, like buildState's values.
      const n = 1 + Math.floor(random() * max);
      for (let i = 0; i < n; i++) out += pieces[Math.floor(random() * pieces.length)] ?? '';
      return out;
    };
    for (let round = 0; round < 300; round++) {
      const state = Array.from({ length: 1 + Math.floor(random() * 6) }, () => {
        const m: { to?: string; subject?: string; body?: string } = {};
        if (random() < 0.8) m.to = text(random() < 0.2 ? 3000 : 20);
        if (random() < 0.8) m.subject = text(random() < 0.2 ? 3000 : 20);
        if (random() < 0.8) m.body = text(4000);
        return m;
      });
      const reserved = Math.floor(random() * JEV_LIMIT_TOKENS * 1.1);
      const { state: out, truncated } = truncateState(state, reserved);

      expect(out.length).toBeGreaterThanOrEqual(1);
      if (estimateStateTokens(out) + reserved > JEV_LIMIT_TOKENS) expect(out).toEqual([{}]);
      out.forEach((m, i) => {
        const original = new Map(Object.entries(state[i] ?? {}));
        for (const [key, value] of Object.entries(m)) {
          const before = original.get(key) ?? '';
          expect(before.startsWith(value)).toBe(true);
          expect(value).not.toBe('');
          expect(endsOnHigh(value) && !endsOnHigh(before)).toBe(false);
        }
      });
      if (truncated === undefined) {
        expect(out).toEqual(state);
      } else {
        expect(truncated.charsDropped).toBe(textLength(state) - textLength(out));
        expect(truncated.messagesDropped).toBe(state.length - out.length);
      }
    }
  });
});
