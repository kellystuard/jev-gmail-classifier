import { describe, expect, it } from 'vitest';

import { INITIAL_ROUND_ESTIMATE_MS } from '../../src/app/jev-sender.ts';
import { InvalidArgumentError } from '../../src/core/errors.ts';
import {
  CHUNK_UNIT_OVERHEAD,
  GMAIL_UNIT_COST,
  THREAD_UNIT_ESTIMATE,
  canStartChunk,
  runLimits,
  type RunKind,
  type TriggerInterval,
} from '../../src/core/run-limits.ts';
import type { GmailPort } from '../../src/ports/gmail-port.ts';
import { GMAIL_UNIT_COSTS } from '../fakes/fake-gmail.ts';

type Case = {
  readonly kind: RunKind;
  readonly interval: TriggerInterval;
  readonly softLimitMs: number;
  readonly chunkSize: number;
  readonly units: number;
  readonly minChunkStartMs: number;
};

const SCHEDULED: readonly (readonly [TriggerInterval, number, number, number, number])[] = [
  [1, 8000, 5, 1000, 7000],
  [5, 15_000, 20, 3000, 13_000],
  [10, 30_000, 20, 3000, 13_000],
  [15, 30_000, 20, 3000, 13_000],
  [30, 30_000, 20, 3000, 13_000],
];

const INTERVALS: readonly TriggerInterval[] = [1, 5, 10, 15, 30];

const CASES: readonly Case[] = [
  ...SCHEDULED.map(([interval, softLimitMs, chunkSize, units, minChunkStartMs]): Case => ({
    kind: 'scheduled',
    interval,
    softLimitMs,
    chunkSize,
    units,
    minChunkStartMs,
  })),
  ...INTERVALS.map((interval): Case => ({
    kind: 'manual',
    interval,
    softLimitMs: 270_000,
    chunkSize: 20,
    units: 13_500,
    minChunkStartMs: 13_000,
  })),
];

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('runLimits', () => {
  it.each(CASES)('$kind / $interval min returns the table row', (c) => {
    expect(runLimits(c.kind, c.interval)).toEqual({
      softLimitMs: c.softLimitMs,
      reserveMs: 10_000,
      chunkSize: c.chunkSize,
      maxGmailUnitsPerRun: c.units,
      minChunkStartMs: c.minChunkStartMs,
    });
  });

  it.each(CASES)('$kind / $interval min: a chunk can start and the hard limit holds', (c) => {
    const limits = runLimits(c.kind, c.interval);
    expect(limits.softLimitMs - 1000).toBeGreaterThanOrEqual(limits.minChunkStartMs);
    expect(limits.softLimitMs + limits.reserveMs).toBeLessThanOrEqual(330_000);
    expect(limits.chunkSize).toBeLessThanOrEqual(20);
    expect(limits.minChunkStartMs).toBe(limits.chunkSize * 400 + INITIAL_ROUND_ESTIMATE_MS);
  });

  it('returns frozen, fresh objects', () => {
    const a = runLimits('scheduled', 10);
    expect(Object.isFrozen(a)).toBe(true);
    expect(runLimits('scheduled', 10)).not.toBe(a);
  });

  it('throws InvalidArgumentError for a kind or interval outside the types', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- deliberately invalid
    const badKind = 'lifecycle' as RunKind;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- deliberately invalid
    const badInterval = 7 as TriggerInterval;
    expect(caught(() => runLimits(badKind, 10))).toBeInstanceOf(InvalidArgumentError);
    expect(caught(() => runLimits('scheduled', badInterval))).toBeInstanceOf(InvalidArgumentError);
  });
});

describe('canStartChunk', () => {
  const limits = runLimits('scheduled', 10);
  const base = { remainingMs: limits.minChunkStartMs, unitsUsed: 0, chunkLength: 20 };
  const fullChunkUnits = 20 * THREAD_UNIT_ESTIMATE + CHUNK_UNIT_OVERHEAD;

  it('is true at exactly minChunkStartMs and exactly the unit cap', () => {
    expect(canStartChunk(base, limits)).toBe(true);
    const atCap = { ...base, unitsUsed: limits.maxGmailUnitsPerRun - fullChunkUnits };
    expect(canStartChunk(atCap, limits)).toBe(true);
  });

  it('is false 1 ms below the minimum and 1 unit over the cap', () => {
    expect(canStartChunk({ ...base, remainingMs: limits.minChunkStartMs - 1 }, limits)).toBe(false);
    const over = { ...base, unitsUsed: limits.maxGmailUnitsPerRun - fullChunkUnits + 1 };
    expect(canStartChunk(over, limits)).toBe(false);
  });

  it('lets a shorter last chunk fit where a full one would not', () => {
    const unitsUsed = limits.maxGmailUnitsPerRun - fullChunkUnits + 1;
    expect(canStartChunk({ ...base, unitsUsed }, limits)).toBe(false);
    expect(canStartChunk({ ...base, unitsUsed, chunkLength: 3 }, limits)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('throws for chunkLength %s', (n) => {
    expect(caught(() => canStartChunk({ ...base, chunkLength: n }, limits))).toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('throws for unitsUsed %s', (n) => {
    expect(caught(() => canStartChunk({ ...base, unitsUsed: n }, limits))).toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it('throws for a NaN remainingMs', () => {
    expect(
      caught(() => canStartChunk({ ...base, remainingMs: Number.NaN }, limits)),
    ).toBeInstanceOf(InvalidArgumentError);
  });
});

describe('tables', () => {
  it('GMAIL_UNIT_COST has exactly the GmailPort methods and the fake costs', () => {
    const table = GMAIL_UNIT_COST satisfies Record<keyof GmailPort, number>;
    expect(table).toEqual(GMAIL_UNIT_COSTS);
  });

  it('derives the per-thread and per-chunk estimates from the table', () => {
    expect(THREAD_UNIT_ESTIMATE).toBe(90);
    expect(THREAD_UNIT_ESTIMATE).toBe(
      GMAIL_UNIT_COSTS.getThread * 2 + GMAIL_UNIT_COSTS.modifyThread,
    );
    expect(CHUNK_UNIT_OVERHEAD).toBe(GMAIL_UNIT_COSTS.searchThreadIds);
  });
});
