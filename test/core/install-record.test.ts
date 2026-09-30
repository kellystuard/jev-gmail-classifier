import { describe, expect, it } from 'vitest';

import { StateError, type StateErrorReason } from '../../src/core/errors.ts';
import {
  decodeInstallRecord,
  encodeInstallRecord,
  INSTALLED_AT_KEY,
  installRecordCodec,
} from '../../src/core/install-record.ts';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('install record codec', () => {
  it('uses the state.installedAt key', () => {
    expect(INSTALLED_AT_KEY).toBe('state.installedAt');
    expect(installRecordCodec.version).toBe(1);
  });

  it.each([0, 1, 1_790_000_000_000])('round-trips at %d, with v first', (at) => {
    const encoded = encodeInstallRecord({ at });
    expect(JSON.stringify(encoded)).toBe(`{"v":1,"at":${String(at)}}`);
    expect(decodeInstallRecord(JSON.parse(JSON.stringify(encoded)))).toEqual({ at });
  });

  it.each<[string, unknown, StateErrorReason]>([
    ['a missing v', { at: 0 }, 'schema'],
    ['v 2', { v: 2, at: 0 }, 'version'],
    ['a negative at', { v: 1, at: -1 }, 'schema'],
    ['a fractional at', { v: 1, at: 1.5 }, 'schema'],
    ['a string at', { v: 1, at: '1' }, 'schema'],
    ['a missing at', { v: 1 }, 'schema'],
    ['an extra field', { v: 1, at: 0, extra: true }, 'schema'],
    ['not an object', 1, 'schema'],
  ])('throws StateError for %s', (_name, raw, reason) => {
    const error = caught(() => decodeInstallRecord(raw));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key: 'state.installedAt', reason });
  });
});
