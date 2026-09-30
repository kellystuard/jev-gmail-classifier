import { describe, expect, it } from 'vitest';

import {
  COMBINED_MARGIN_TOKENS,
  estimateStateTokens,
  estimateTokens,
  JEV_COMBINED_LIMIT_TOKENS,
  JEV_LIMIT_TOKENS,
  MARGIN_TOKENS,
  QUESTION_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
  reservedTokensForQuestions,
} from '../../src/core/token-estimate.ts';

describe('the constants', () => {
  it('are the values #84 measured (SD §8.4)', () => {
    expect({
      JEV_LIMIT_TOKENS,
      JEV_COMBINED_LIMIT_TOKENS,
      REQUEST_OVERHEAD_TOKENS,
      QUESTION_OVERHEAD_TOKENS,
      MARGIN_TOKENS,
      COMBINED_MARGIN_TOKENS,
    }).toEqual({
      JEV_LIMIT_TOKENS: 32768,
      JEV_COMBINED_LIMIT_TOKENS: 65536,
      REQUEST_OVERHEAD_TOKENS: 300,
      QUESTION_OVERHEAD_TOKENS: 10,
      MARGIN_TOKENS: 1000,
      COMBINED_MARGIN_TOKENS: 2000,
    });
  });
});

describe('estimateTokens', () => {
  it.each([
    ['empty', '', 0],
    ['English', 'Is this a newsletter?', 21],
    ['2-byte accents', 'café', 5],
    ['U+007F, the last 1-byte unit', '\u007f', 1],
    ['U+0080, the first 2-byte unit', '\u0080', 2],
    ['U+07FF, the last 2-byte unit', '߿', 2],
    ['U+0800, the first 3-byte unit', 'ࠀ', 3],
    ['CJK', '日本語のテキスト', 24],
    ['a symbol', '€', 3],
    ['an emoji (one surrogate pair)', '😀', 4],
    ['a ZWJ emoji sequence', '👩‍💻', 11],
    ['a lone high surrogate', '\ud83d', 2],
    ['a lone low surrogate', '\ude00', 2],
    ['U+FFFF', '￿', 3],
  ])('%s', (_, text, expected) => {
    expect(estimateTokens(text)).toBe(expected);
  });

  it('is the UTF-8 byte length of well-formed text', () => {
    const text = 'Hello, wörld! 日本語 😀👍🏽 €100 — “quoted”';
    expect(estimateTokens(text)).toBe(new TextEncoder().encode(text).length);
  });

  it('is additive', () => {
    const a = 'Grüße, ';
    const b = '日本 😀';
    expect(estimateTokens(a + b)).toBe(estimateTokens(a) + estimateTokens(b));
  });

  it('estimates state as its serialized JSON, escapes included', () => {
    const state = [{ subject: 'Hi "you"', body: 'line 1\nline 2' }];
    expect(estimateStateTokens(state)).toBe(estimateTokens(JSON.stringify(state)));
    expect(estimateStateTokens([])).toBe(2);
  });
});

/**
 * Every request of `spikes/84-token-ratio.md` whose `state` size was recorded,
 * as [name, state JSON ASCII units, state JSON non-ASCII units, state JSON
 * UTF-8 bytes, question estimates, measured `input_tokens`]. The text is
 * regenerated from those counts: 2- and 3-byte units (and surrogate halves,
 * which count like 2-byte units) in the proportion the bytes give.
 */
const QUESTION = 'Is this email a newsletter or marketing message?';
const q48 = [48];
const measured: readonly [string, number, number, number, readonly number[], number][] = [
  ['kind-prose-4500', 4701, 0, 4701, q48, 1138],
  ['kind-prose-18000', 18257, 0, 18257, q48, 3464],
  ['kind-prose-45000', 45359, 0, 45359, q48, 8111],
  ['kind-prose-90000', 90549, 0, 90549, q48, 15896],
  ['kind-marketing-2500', 2712, 0, 2712, q48, 1481],
  ['kind-marketing-10000', 10276, 0, 10276, q48, 4872],
  ['kind-marketing-25000', 25420, 0, 25420, q48, 11512],
  ['kind-marketing-50000', 50638, 0, 50638, q48, 22720],
  ['kind-escapes-2500', 3252, 0, 3252, q48, 1370],
  ['kind-escapes-10000', 12574, 0, 12574, q48, 4498],
  ['kind-escapes-25000', 31148, 0, 31148, q48, 10639],
  ['kind-escapes-50000', 62132, 0, 62132, q48, 20956],
  ['kind-cjk-1000', 207, 991, 3180, q48, 1357],
  ['kind-cjk-4000', 261, 3964, 12153, q48, 4357],
  ['kind-cjk-10000', 363, 9913, 30102, q48, 10357],
  ['kind-cjk-20000', 549, 19820, 60009, q48, 20357],
  ['kind-emoji-600', 262, 537, 1413, q48, 972],
  ['kind-emoji-2400', 480, 2135, 5083, q48, 2789],
  ['kind-emoji-6000', 913, 5346, 12451, q48, 6470],
  ['kind-emoji-12000', 1620, 10705, 24655, q48, 12584],
  ['question-50', 209, 0, 209, [48], 363],
  ['question-2000', 209, 0, 209, [2022], 705],
  ['question-8000', 209, 0, 209, [8022], 1745],
  ['question-20000', 209, 0, 209, [20022], 3817],
  ['messages-1', 209, 0, 209, q48, 362],
  ['messages-4', 833, 0, 833, q48, 626],
  ['messages-16', 3329, 0, 3329, q48, 1682],
  ['messages-64', 13313, 0, 13313, q48, 5906],
  ['questions-1', 209, 0, 209, q48, 363],
  ['questions-2', 209, 0, 209, Array<number>(2).fill(48), 379],
  ['questions-5', 209, 0, 209, Array<number>(5).fill(48), 427],
  ['questions-10', 209, 0, 209, Array<number>(10).fill(48), 507],
  ['minimal-body-only', 16, 0, 16, [5], 279],
  ['minimal-headers', 192, 0, 192, [5], 353],
  ['minimal-repeat', 16, 0, 16, [5], 279],
  ['kind-base64-1500', 1708, 0, 1708, q48, 1412],
  ['kind-base64-7500', 7786, 0, 7786, q48, 5667],
  ['kind-base64-22500', 22981, 0, 22981, q48, 16358],
  ['kind-latin-3500', 3490, 215, 3920, q48, 1212],
  ['kind-latin-17500', 16693, 1060, 18813, q48, 4572],
  ['kind-latin-52500', 49775, 3160, 56095, q48, 13006],
  ['kind-cyrillic-2000', 582, 1615, 3812, q48, 1324],
  ['kind-cyrillic-8000', 1753, 6468, 14689, q48, 4286],
  ['kind-greek-2000', 583, 1615, 3813, q48, 1700],
  ['kind-greek-8000', 1756, 6465, 14686, q48, 5738],
  ['kind-arabic-2000', 612, 1589, 3790, q48, 1519],
  ['kind-arabic-8000', 1869, 6358, 14585, q48, 4971],
  ['kind-devanagari-2000', 634, 1564, 5326, q48, 1561],
  ['kind-devanagari-8000', 1975, 6251, 20728, q48, 5069],
  ['kind-thai-2000', 255, 1944, 6087, q48, 2357],
  ['kind-thai-8000', 456, 7767, 23757, q48, 8357],
  ['kind-hangul-2000', 736, 1473, 5155, q48, 1809],
  ['kind-hangul-8000', 2427, 5832, 19923, q48, 6057],
  ['kind-cjkExtB-2000', 369, 1848, 4065, q48, 3884],
  ['kind-cjkExtB-8000', 898, 7406, 15710, q48, 14292],
  ['kind-cjkExtA-2000', 507, 1735, 5712, q48, 5827],
  ['kind-cjkExtA-8000', 1468, 6932, 22264, q48, 22221],
  ['kind-symbols-2000', 1268, 934, 3941, q48, 1715],
  ['kind-symbols-8000', 4438, 3808, 15329, q48, 5922],
];

/** Text with `ascii` ASCII units and `nonAscii` other units totalling `bytes` UTF-8 bytes. */
function regenerate(ascii: number, nonAscii: number, bytes: number): string {
  const threeByte = bytes - ascii - 2 * nonAscii;
  const twoByte = nonAscii - threeByte;
  expect(threeByte).toBeGreaterThanOrEqual(0);
  expect(twoByte).toBeGreaterThanOrEqual(0);
  return 'a'.repeat(ascii) + 'é'.repeat(twoByte) + '中'.repeat(threeByte);
}

describe('estimateTokens against the #84 measurements', () => {
  it('uses a 48-character question', () => {
    expect(QUESTION).toHaveLength(48);
  });

  it.each(measured)(
    '%s: the request estimate is never below input_tokens',
    (_, ascii, nonAscii, bytes, questionChars, inputTokens) => {
      const state = regenerate(ascii, nonAscii, bytes);
      expect(estimateTokens(state)).toBe(bytes);
      const questions = questionChars.map((chars) =>
        QUESTION.repeat(Math.ceil(chars / 48)).slice(0, chars),
      );
      const estimate =
        estimateTokens(state) +
        questions.reduce((sum, q) => sum + estimateTokens(q), 0) +
        REQUEST_OVERHEAD_TOKENS +
        QUESTION_OVERHEAD_TOKENS * questions.length;
      expect(estimate).toBeGreaterThanOrEqual(inputTokens);
    },
  );
});

describe('reservedTokensForQuestions', () => {
  it.each<[string, readonly string[], number]>([
    ['no questions: overhead and margin only', [], 300 + 1000],
    ['one question', ['Spam?'], 5 + 10 + 300 + 1000],
    ['the largest estimate, not the longest string', ['a'.repeat(30), '中'.repeat(20)], 60 + 1310],
    ['many short questions: the 32k rule', Array<string>(50).fill('x'.repeat(100)), 100 + 1310],
    [
      'long questions: the 64k rule wins',
      Array<string>(8).fill('x'.repeat(5000)),
      8 * 5000 + 8 * 10 + 300 + 2000 - 32768,
    ],
  ])('%s', (_, questions, expected) => {
    expect(reservedTokensForQuestions(questions)).toBe(expected);
  });

  it.each<[string, readonly string[]]>([
    ['one', ['Is this a newsletter?']],
    ['CJK and English', ['これはニュースレターですか？', 'Is this a receipt for a purchase?']],
    ['near the crossover', Array<string>(4).fill('q'.repeat(10_600))],
    ['past the crossover', Array<string>(4).fill('q'.repeat(11_000))],
    ['many', Array<string>(100).fill('Does this ask me to do something by a date?')],
  ])('the largest state it allows is exactly SD §8.4’s: %s', (_, questions) => {
    const q = questions.map(estimateTokens);
    const n = q.length;
    const largest = Math.max(...q);
    const total = q.reduce((a, b) => a + b, 0);
    const expected = Math.min(31458 - largest, 63236 - 10 * n - total);
    const allowed = JEV_LIMIT_TOKENS - reservedTokensForQuestions(questions);
    expect(allowed).toBe(expected);
    // Both rules hold at the allowed size, and one of them fails one token above.
    const holds = (s: number): boolean =>
      s + largest + 300 + 10 + 1000 <= 32768 && s + total + 300 + 10 * n + 2000 <= 65536;
    expect(holds(allowed)).toBe(true);
    expect(holds(allowed + 1)).toBe(false);
  });
});
