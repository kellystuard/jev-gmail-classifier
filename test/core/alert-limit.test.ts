import { describe, expect, it } from 'vitest';

import type { AlertCondition } from '../../src/core/alert-condition.ts';
import {
  ALERTS_KEY,
  alertRecordCodec,
  type AlertRecord,
  decodeAlertRecord,
  dueAlerts,
  encodeAlertRecord,
  markAlertSent,
} from '../../src/core/alert-limit.ts';
import { InvalidArgumentError, StateError, type StateErrorReason } from '../../src/core/errors.ts';

const TODAY = '2026-10-01';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('alert record codec', () => {
  const full: AlertRecord = {
    sent: {
      auth: TODAY,
      errored: TODAY,
      run_failures: TODAY,
      budget_reached: TODAY,
      scope_missing: TODAY,
      history_expired: TODAY,
      config_invalid: TODAY,
    },
  };

  it('uses the state.alerts key, version 1', () => {
    expect(ALERTS_KEY).toBe('state.alerts');
    expect(alertRecordCodec.version).toBe(1);
  });

  it('round-trips a full record, with v first', () => {
    const encoded = encodeAlertRecord(full);
    expect(JSON.stringify(encoded)).toMatch(/^{"v":1,"sent":/);
    expect(decodeAlertRecord(JSON.parse(JSON.stringify(encoded)))).toEqual(full);
  });

  it('writes the keys in ALERT_CONDITIONS order whatever the build order', () => {
    const ordered: AlertRecord = { sent: { auth: '2026-09-30', config_invalid: TODAY } };
    const shuffled: AlertRecord = { sent: { config_invalid: TODAY, auth: '2026-09-30' } };
    expect(JSON.stringify(encodeAlertRecord(shuffled))).toBe(
      JSON.stringify(encodeAlertRecord(ordered)),
    );
    expect(JSON.stringify(encodeAlertRecord(shuffled))).toBe(
      '{"v":1,"sent":{"auth":"2026-09-30","config_invalid":"2026-10-01"}}',
    );
  });

  it('decodes an empty sent, with no key for an absent condition', () => {
    const record = decodeAlertRecord({ v: 1, sent: {} });
    expect(record).toEqual({ sent: {} });
    expect(Object.keys(record.sent)).toEqual([]);
    const one = decodeAlertRecord({ v: 1, sent: { errored: TODAY } });
    expect(Object.keys(one.sent)).toEqual(['errored']);
  });

  it.each<[string, unknown, StateErrorReason]>([
    ['v 2', { v: 2, sent: {} }, 'version'],
    ['no v', { sent: {} }, 'schema'],
    ['no sent', { v: 1 }, 'schema'],
    ['sent an array', { v: 1, sent: [] }, 'schema'],
    ['an unknown condition', { v: 1, sent: { nope: TODAY } }, 'schema'],
    ['a non-string day', { v: 1, sent: { auth: 20261001 } }, 'schema'],
    ['a month 13', { v: 1, sent: { auth: '2026-13-01' } }, 'schema'],
    ['Feb 30', { v: 1, sent: { auth: '2026-02-30' } }, 'schema'],
    ['a short day', { v: 1, sent: { auth: '2026-10-1' } }, 'schema'],
    ['an extra top-level key', { v: 1, sent: {}, more: 1 }, 'schema'],
    ['null', null, 'schema'],
    ['a string', 'x', 'schema'],
  ])('rejects %s', (_name, raw, reason) => {
    const error = caught(() => decodeAlertRecord(raw));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ reason });
  });
});

describe('dueAlerts', () => {
  const record: AlertRecord = {
    sent: { auth: TODAY, errored: '2026-09-30', run_failures: '2026-10-05' },
  };

  it.each<[string, AlertRecord | undefined, AlertCondition[], AlertCondition[]]>([
    ['no record', undefined, ['auth', 'errored'], ['auth', 'errored']],
    ['sent today', record, ['auth'], []],
    ['sent yesterday', record, ['errored'], ['errored']],
    ['a later stored day', record, ['run_failures'], ['run_failures']],
    ['never sent, absent from the record', record, ['scope_missing'], ['scope_missing']],
    [
      'a mix keeps the given order',
      record,
      ['run_failures', 'auth', 'scope_missing', 'errored'],
      ['run_failures', 'scope_missing', 'errored'],
    ],
    ['duplicates removed', record, ['errored', 'auth', 'errored'], ['errored']],
    ['an empty input', record, [], []],
    ['an empty input and no record', undefined, [], []],
  ])('%s', (_name, rec, conditions, expected) => {
    expect(dueAlerts(rec, conditions, TODAY)).toEqual(expected);
  });

  it('never returns a condition that was not given', () => {
    expect(dueAlerts(undefined, ['auth'], TODAY)).toEqual(['auth']);
  });

  it('changes neither its input nor the record', () => {
    const conditions: AlertCondition[] = ['errored', 'auth'];
    const before = JSON.stringify(record);
    const result = dueAlerts(record, conditions, TODAY);
    expect(result).not.toBe(conditions);
    expect(conditions).toEqual(['errored', 'auth']);
    expect(JSON.stringify(record)).toBe(before);
  });

  it.each(['2026-10-1', ''])('throws for today of %j', (today) => {
    const error = caught(() => dueAlerts(undefined, ['auth'], today));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toMatchObject({ argument: 'today', reason: 'not_a_day' });
  });
});

describe('markAlertSent', () => {
  it('starts a record from none', () => {
    expect(markAlertSent(undefined, 'auth', TODAY)).toEqual({ sent: { auth: TODAY } });
  });

  it('adds a condition and keeps the others', () => {
    const first = markAlertSent(undefined, 'errored', '2026-09-30');
    expect(markAlertSent(first, 'auth', TODAY)).toEqual({
      sent: { auth: TODAY, errored: '2026-09-30' },
    });
  });

  it.each(['2026-09-01', '2026-11-01'])('overwrites the stored day %s', (old) => {
    expect(markAlertSent({ sent: { auth: old } }, 'auth', TODAY)).toEqual({
      sent: { auth: TODAY },
    });
  });

  it('does not mutate its input', () => {
    const record: AlertRecord = { sent: { errored: '2026-09-30' } };
    const copy = structuredClone(record);
    markAlertSent(record, 'auth', TODAY);
    expect(record).toEqual(copy);
  });

  it('gives a record that survives the codec', () => {
    const result = markAlertSent(markAlertSent(undefined, 'config_invalid', TODAY), 'auth', TODAY);
    expect(decodeAlertRecord(encodeAlertRecord(result))).toEqual(result);
  });

  it('throws for a bad today', () => {
    const error = caught(() => markAlertSent(undefined, 'auth', '2026-10-1'));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toMatchObject({ argument: 'today', reason: 'not_a_day' });
  });
});

describe('together', () => {
  it('rate-limits to once a day', () => {
    const result = markAlertSent(undefined, 'auth', TODAY);
    expect(dueAlerts(result, ['auth', 'errored'], TODAY)).toEqual(['errored']);
    expect(dueAlerts(result, ['auth', 'errored'], '2026-10-02')).toEqual(['auth', 'errored']);
  });
});
