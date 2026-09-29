import { describe, expect, it } from 'vitest';

import { StateError } from '../../src/core/errors.ts';
import { STATE_STORE_MAX_BYTES, STATE_VALUE_MAX_BYTES } from '../../src/core/state-limits.ts';
import {
  assertInputName,
  assertStateKey,
  checkStateWrite,
  parseStateText,
  propertyBytes,
} from '../../src/core/state-rules.ts';

function caught(fn: () => unknown): StateError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StateError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a throw');
}

describe('assertStateKey', () => {
  it('accepts state.* keys', () => {
    expect(() => {
      assertStateKey('state.x');
    }).not.toThrow();
  });

  it.each(['MANUAL_QUERY', 'JEV_API_KEY', 'statex', 'State.x', ''])('rejects %j', (key) => {
    const error = caught(() => {
      assertStateKey(key);
    });
    expect(error.reason).toBe('bad_key');
    expect(error.key).toBe(key);
  });
});

describe('assertInputName', () => {
  it.each(['MANUAL_QUERY', 'RESET_POSITION', 'statex'])('accepts %j', (name) => {
    expect(() => {
      assertInputName(name);
    }).not.toThrow();
  });

  it.each(['state.x', 'state.', 'JEV_API_KEY'])('rejects %j', (name) => {
    expect(
      caught(() => {
        assertInputName(name);
      }).reason,
    ).toBe('bad_key');
  });
});

describe('propertyBytes', () => {
  it.each([
    ['state.a', '{}', 9],
    ['state.é', '"é"', 8 + 4],
    ['state.€', '"€"', 9 + 5],
    ['state.a', '"😀"', 7 + 6],
  ])('counts %j and %j in UTF-8 bytes', (key, text, bytes) => {
    expect(propertyBytes(key, text)).toBe(bytes);
  });
});

describe('checkStateWrite', () => {
  const key = 'state.k';
  const keyBytes = 7;

  it('passes a value of exactly 9 KB and throws too_large one byte over', () => {
    expect(checkStateWrite(key, 'x'.repeat(STATE_VALUE_MAX_BYTES), 0, 0)).toBe(
      keyBytes + STATE_VALUE_MAX_BYTES,
    );
    const error = caught(() => checkStateWrite(key, 'x'.repeat(STATE_VALUE_MAX_BYTES + 1), 0, 0));
    expect(error).toMatchObject({
      reason: 'too_large',
      key,
      bytes: STATE_VALUE_MAX_BYTES + 1,
      limit: STATE_VALUE_MAX_BYTES,
    });
  });

  it('counts the 9 KB limit in UTF-8 bytes', () => {
    const half = 'é'.repeat(STATE_VALUE_MAX_BYTES / 2);
    expect(checkStateWrite(key, half, 0, 0)).toBe(keyBytes + STATE_VALUE_MAX_BYTES);
    expect(caught(() => checkStateWrite(key, `${half}é`, 0, 0)).reason).toBe('too_large');
  });

  it('passes a write that takes the store to exactly 500 KB and throws store_full one byte over', () => {
    const text = '{}';
    const room = STATE_STORE_MAX_BYTES - keyBytes - text.length;
    expect(checkStateWrite(key, text, room, 0)).toBe(STATE_STORE_MAX_BYTES);
    const error = caught(() => checkStateWrite(key, text, room + 1, 0));
    expect(error).toMatchObject({
      reason: 'store_full',
      key,
      bytes: STATE_STORE_MAX_BYTES + 1,
      limit: STATE_STORE_MAX_BYTES,
    });
  });

  it('counts only the difference for an overwrite', () => {
    const current = propertyBytes(key, 'x'.repeat(100));
    // A full store: overwriting 100 bytes with 100 is fine, and with 101 is one byte over.
    expect(checkStateWrite(key, 'x'.repeat(100), STATE_STORE_MAX_BYTES, current)).toBe(
      STATE_STORE_MAX_BYTES,
    );
    expect(
      caught(() => checkStateWrite(key, 'x'.repeat(101), STATE_STORE_MAX_BYTES, current)).reason,
    ).toBe('store_full');
    // A smaller value shrinks the total.
    expect(checkStateWrite(key, 'x', STATE_STORE_MAX_BYTES, current)).toBe(
      STATE_STORE_MAX_BYTES - 99,
    );
  });

  it('checks the value size before the store size', () => {
    const error = caught(() =>
      checkStateWrite(key, 'x'.repeat(STATE_VALUE_MAX_BYTES + 1), STATE_STORE_MAX_BYTES, 0),
    );
    expect(error.reason).toBe('too_large');
  });

  it('counts a multi-byte key in UTF-8 bytes', () => {
    expect(checkStateWrite('state.€', '{}', 100, 0)).toBe(100 + 9 + 2);
  });
});

describe('parseStateText', () => {
  it('parses JSON', () => {
    expect(parseStateText('state.k', '{"v":1}')).toEqual({ v: 1 });
    expect(parseStateText('state.k', 'null')).toBeNull();
  });

  it('throws parse with the cause, naming the key and not the text', () => {
    const secret = '{"v":1,"subject":"private"';
    const error = caught(() => parseStateText('state.k', secret));
    expect(error.reason).toBe('parse');
    expect(error.key).toBe('state.k');
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expect(error.message).toContain('state.k');
    expect(error.message).not.toContain('private');
    expect(JSON.stringify(error.toLogFields())).not.toContain('private');
  });
});
