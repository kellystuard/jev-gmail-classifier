import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from '../../src/core/errors.ts';
import { parseTimespan, timespanAfterSeconds } from '../../src/core/timespan.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe('parseTimespan', () => {
  it.each([
    ['1h', HOUR, '1h'],
    ['2h', 2 * HOUR, '2h'],
    ['36H', 36 * HOUR, '36h'],
    ['7d', 7 * DAY, '7d'],
    ['7D', 7 * DAY, '7d'],
    ['4w', 4 * WEEK, '4w'],
    ['4W', 4 * WEEK, '4w'],
    ['99999w', 99_999 * WEEK, '99999w'],
    ['99999h', 99_999 * HOUR, '99999h'],
    ['  7d  ', 7 * DAY, '7d'],
  ])('accepts %j', (text, ms, canonical) => {
    expect(parseTimespan(text)).toEqual({ ok: true, ms, text: canonical });
  });

  it.each([
    '',
    '   ',
    '0h',
    '0',
    '007d',
    '01h',
    '1.5d',
    '1,5d',
    '-2h',
    '+2h',
    '2 h',
    '1d12h',
    '2hours',
    '2hd',
    '7',
    'h',
    'd7',
    '100000h',
    '2e3h',
    '0x10h',
    '７d',
    '7\nd',
    '30m',
    '30M',
    '1y',
    '1Y',
  ])('refuses %j', (text) => {
    expect(parseTimespan(text)).toEqual({ ok: false, kind: 'invalid_timespan' });
  });
});

describe('timespanAfterSeconds', () => {
  it.each([
    [1_790_000_000_500, 2 * HOUR, 1_789_992_800],
    [1_790_000_000_999, 0, 1_790_000_000],
    [1_790_000_000_999, 1000, 1_789_999_999],
    [5 * HOUR, 5 * HOUR, 0],
    [DAY, 99_999 * WEEK, 0],
    [1_790_000_000_500, 0, 1_790_000_000],
  ])('now %d, span %d gives %d', (nowMs, spanMs, expected) => {
    expect(timespanAfterSeconds(nowMs, spanMs)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])('throws for nowMs %d', (bad) => {
    expect(() => timespanAfterSeconds(bad, HOUR)).toThrow(InvalidArgumentError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])('throws for spanMs %d', (bad) => {
    expect(() => timespanAfterSeconds(DAY, bad)).toThrow(InvalidArgumentError);
  });
});
