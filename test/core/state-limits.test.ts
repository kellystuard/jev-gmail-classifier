import { describe, expect, it } from 'vitest';

import {
  STATE_STORE_MAX_BYTES,
  STATE_VALUE_MAX_BYTES,
  utf8ByteLength,
} from '../../src/core/state-limits.ts';

describe('utf8ByteLength', () => {
  it.each([
    ['empty', '', 0],
    ['ASCII', 'state.queue.0', 13],
    ['2-byte characters', 'é£', 4],
    ['3-byte characters', '€日本', 9],
    ['4-byte emoji (a surrogate pair)', '😀', 4],
    ['mixed', 'a é € 😀', 13],
    ['a lone high surrogate', '\ud83d', 3],
    ['a lone low surrogate', 'x\ude00', 4],
    ['a high surrogate before a non-surrogate', '\ud83dA', 4],
  ])('counts %s', (_name, text, expected) => {
    expect(utf8ByteLength(text)).toBe(expected);
    // Node's encoder agrees, including U+FFFD for lone surrogates.
    expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('counts JSON text as stored', () => {
    const json = JSON.stringify({ v: 1, subject: 'Café ☕ 😀' });
    expect(utf8ByteLength(json)).toBe(Buffer.byteLength(json, 'utf8'));
  });
});

describe('limits', () => {
  it('are 9 KB per value and 500 KB per store', () => {
    expect(STATE_VALUE_MAX_BYTES).toBe(9216);
    expect(STATE_STORE_MAX_BYTES).toBe(512000);
  });
});
