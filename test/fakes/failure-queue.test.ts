import { describe, expect, it } from 'vitest';

import { FailureQueue } from './failure-queue.ts';

type Method = 'get' | 'set';

/** Calls `take('set')` `count` times and records `ok` or the thrown message for each. */
function outcomes(queue: FailureQueue<Method, never>, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    try {
      queue.take('set');
      out.push('ok');
    } catch (error) {
      out.push(error instanceof Error ? error.message : 'non-error');
    }
  }
  return out;
}

describe('FailureQueue after', () => {
  it.each([
    ['no after: the next call fails', {}, ['boom', 'ok', 'ok', 'ok']],
    ['after 0: the next call fails', { after: 0 }, ['boom', 'ok', 'ok', 'ok']],
    ['after 1: one call succeeds, then one fails', { after: 1 }, ['ok', 'boom', 'ok', 'ok']],
    ['after 2', { after: 2 }, ['ok', 'ok', 'boom', 'ok']],
    [
      'after 1 with times 2: one succeeds, then two fail',
      { after: 1, times: 2 },
      ['ok', 'boom', 'boom', 'ok'],
    ],
  ])('%s', (_name, options, expected) => {
    const queue = new FailureQueue<Method, never>();
    queue.add('set', new Error('boom'), options);
    expect(outcomes(queue, 4)).toEqual(expected);
    expect(queue.pending).toBe(0);
  });

  it('counts only matching calls', () => {
    const queue = new FailureQueue<Method, never>();
    queue.add('set', new Error('boom'), { after: 1 });
    queue.take('get');
    queue.take('get');
    expect(outcomes(queue, 2)).toEqual(['ok', 'boom']);
  });

  it('keeps later entries for the same method waiting until the first one is used', () => {
    const queue = new FailureQueue<Method, never>();
    queue.add('set', new Error('first'), { after: 1 });
    queue.add('set', new Error('second'));
    expect(outcomes(queue, 4)).toEqual(['ok', 'first', 'second', 'ok']);
  });

  it('counts only failures as pending, not the calls it lets through', () => {
    const queue = new FailureQueue<Method, never>();
    queue.add('set', new Error('boom'), { after: 3, times: 2 });
    expect(queue.pending).toBe(2);
  });

  it.each([-1, 1.5, Number.NaN])('rejects after %s', (after) => {
    const queue = new FailureQueue<Method, never>();
    expect(() => {
      queue.add('set', new Error('boom'), { after });
    }).toThrow('failNext: after must be a non-negative integer');
  });
});
