import { describe, expect, it } from 'vitest';

import { StateError, type StateErrorReason } from '../../src/core/errors.ts';
import {
  decodePosition,
  encodePosition,
  POSITION_KEY,
  positionCodec,
} from '../../src/core/position.ts';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('position codec', () => {
  it('uses the state.position key', () => {
    expect(POSITION_KEY).toBe('state.position');
    expect(positionCodec.version).toBe(1);
  });

  it.each([
    ['a small historyId', { historyId: '1', savedAt: 0 }],
    ['a typical one', { historyId: '36598780', savedAt: 1_790_000_000_000 }],
    ['the largest uint64', { historyId: '18446744073709551615', savedAt: 1 }],
    ['20 digits with leading zeros', { historyId: '00000000000000000001', savedAt: 1 }],
  ])('round-trips %s, with v first', (_name, position) => {
    const encoded = encodePosition(position);
    expect(JSON.stringify(encoded)).toBe(
      `{"v":1,"historyId":"${position.historyId}","savedAt":${String(position.savedAt)}}`,
    );
    expect(decodePosition(JSON.parse(JSON.stringify(encoded)))).toEqual(position);
  });

  it.each<[string, unknown, StateErrorReason]>([
    ['a missing v', { historyId: '1', savedAt: 0 }, 'schema'],
    ['a newer v', { v: 2, historyId: '1', savedAt: 0 }, 'version'],
    ['v 0', { v: 0, historyId: '1', savedAt: 0 }, 'version'],
    ['a numeric historyId', { v: 1, historyId: 123, savedAt: 0 }, 'schema'],
    ['historyId "abc"', { v: 1, historyId: 'abc', savedAt: 0 }, 'schema'],
    ['an empty historyId', { v: 1, historyId: '', savedAt: 0 }, 'schema'],
    ['a 21-digit historyId', { v: 1, historyId: '1'.repeat(21), savedAt: 0 }, 'schema'],
    ['a signed historyId', { v: 1, historyId: '-1', savedAt: 0 }, 'schema'],
    ['a negative savedAt', { v: 1, historyId: '1', savedAt: -1 }, 'schema'],
    ['a fractional savedAt', { v: 1, historyId: '1', savedAt: 1.5 }, 'schema'],
    ['a missing savedAt', { v: 1, historyId: '1' }, 'schema'],
    ['an extra field', { v: 1, historyId: '1', savedAt: 0, extra: true }, 'schema'],
    ['not an object', '36598780', 'schema'],
  ])('throws StateError %s', (_name, raw, reason) => {
    const error = caught(() => decodePosition(raw));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key: 'state.position', reason });
  });
});
