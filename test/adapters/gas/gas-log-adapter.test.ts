import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GasLogAdapter } from '../../../src/adapters/gas/gas-log-adapter.ts';

// The one adapter whose output format matters to E9 (#142): its line format is
// checked here with stubbed `Utilities` and `console`.
describe('GasLogAdapter', () => {
  const info = vi.fn<(line: string) => void>();
  const warn = vi.fn<(line: string) => void>();
  const error = vi.fn<(line: string) => void>();
  let uuids = 0;

  beforeEach(() => {
    uuids = 0;
    info.mockReset();
    warn.mockReset();
    error.mockReset();
    vi.stubGlobal('Utilities', { getUuid: () => `uuid-${String(++uuids)}` });
    vi.stubGlobal('console', { info, warn, error });
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 30, 12, 0, 0) });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function only(mock: typeof info): string {
    expect(mock).toHaveBeenCalledOnce();
    const [line] = mock.mock.calls[0] ?? [];
    if (line === undefined) throw new Error('no line');
    return line;
  }

  it('writes one JSON line: event, runId, entry, ts, then the fields', () => {
    new GasLogAdapter({ entry: 'onTrigger' }).info('run.end', { chunks: 2, alerts: ['auth'] });

    expect(only(info)).toBe(
      JSON.stringify({
        event: 'run.end',
        runId: 'uuid-1',
        entry: 'onTrigger',
        ts: '2026-09-30T12:00:00.000Z',
        chunks: 2,
        alerts: ['auth'],
      }),
    );
  });

  it('writes each level with its console method', () => {
    const log = new GasLogAdapter({ entry: 'install' });
    log.info('run.start');
    log.warn('scope_missing', { scope: 'unknown' });
    log.error('run.failed', { error: 'ConfigError' });

    expect(JSON.parse(only(info))).toMatchObject({ event: 'run.start' });
    expect(JSON.parse(only(warn))).toMatchObject({ event: 'scope_missing', scope: 'unknown' });
    expect(JSON.parse(only(error))).toMatchObject({ event: 'run.failed', error: 'ConfigError' });
  });

  it('keeps one runId per instance, and a new one per instance', () => {
    const first = new GasLogAdapter({ entry: 'onTrigger' });
    first.info('run.start');
    first.info('run.end');
    new GasLogAdapter({ entry: 'onTrigger' }).info('run.start');

    const runIds = info.mock.calls.map(([line]) => {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === 'object' && parsed !== null && 'runId' in parsed
        ? parsed.runId
        : undefined;
    });
    expect(runIds).toEqual(['uuid-1', 'uuid-1', 'uuid-2']);
  });

  it("doesn't let a field override the reserved keys", () => {
    new GasLogAdapter({ entry: 'uninstall' }).info('run.end', {
      event: 'other',
      runId: 'x',
      entry: 'y',
      ts: 'z',
      keysDeleted: 3,
    });

    expect(JSON.parse(only(info))).toEqual({
      event: 'run.end',
      runId: 'uuid-1',
      entry: 'uninstall',
      ts: '2026-09-30T12:00:00.000Z',
      keysDeleted: 3,
    });
  });

  it('writes logError instead of throwing when the fields cannot be serialized', () => {
    // The type system allows no such field: a getter that throws stands in for one.
    const fields: Record<string, number> = {};
    Object.defineProperty(fields, 'size', {
      enumerable: true,
      get: () => {
        throw new TypeError('Do not know how to serialize a BigInt');
      },
    });

    new GasLogAdapter({ entry: 'onTrigger' }).warn('thread.failed', fields);

    expect(JSON.parse(only(warn))).toEqual({
      event: 'thread.failed',
      runId: 'uuid-1',
      entry: 'onTrigger',
      ts: '2026-09-30T12:00:00.000Z',
      logError: 'unserializable',
    });
  });
});
