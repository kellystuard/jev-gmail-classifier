import { describe, expect, it } from 'vitest';

import { FakeLog } from './fake-log.ts';

describe('FakeLog', () => {
  it('records events in order, with their level and fields', () => {
    const log = new FakeLog();
    log.info('run.start');
    log.warn('scope_missing', { scope: 'gmail.modify' });
    log.info('thread.classified', { threadId: 't1', probabilities: { a: 0.9 } });
    log.error('run.failed');
    expect(log.events).toEqual([
      { level: 'info', event: 'run.start', fields: {} },
      { level: 'warn', event: 'scope_missing', fields: { scope: 'gmail.modify' } },
      {
        level: 'info',
        event: 'thread.classified',
        fields: { threadId: 't1', probabilities: { a: 0.9 } },
      },
      { level: 'error', event: 'run.failed', fields: {} },
    ]);
  });

  it('finds events by name and level', () => {
    const log = new FakeLog();
    log.info('thread.classified', { threadId: 't1' });
    log.info('thread.classified', { threadId: 't2' });
    log.warn('thread.strike');
    expect(log.find('thread.classified')?.fields).toEqual({ threadId: 't1' });
    expect(log.find('run.end')).toBeUndefined();
    expect(log.all('thread.classified')).toHaveLength(2);
    expect(log.atLevel('warn').map((e) => e.event)).toEqual(['thread.strike']);
  });

  it.each(['Run.start', 'run..start', 'run-start', '.run', 'run.', '1run', ''])(
    'throws on the event name "%s"',
    (event) => {
      const log = new FakeLog();
      expect(() => {
        log.info(event);
      }).toThrow(/event name/);
      expect(log.events).toEqual([]);
    },
  );

  it.each([
    'body',
    'state',
    'authorization',
    'apiKey',
    'Body',
    'APIKEY',
    'secret',
    'password',
    'token',
    'pageToken',
    'page_token',
    'JEV_API_KEY',
    'api-key',
  ])('throws on a "%s" field', (name) => {
    const log = new FakeLog();
    expect(() => {
      log.info('thread.classified', { [name]: 'x' });
    }).toThrow(/forbidden field/);
    expect(log.events).toEqual([]);
  });

  it('allows field names that only contain a forbidden word', () => {
    const log = new FakeLog();
    log.info('thread.classified', {
      bodyLength: 10,
      stateKey: 'state.queue.0',
      key: 'state.queue.0',
      inputTokens: 5,
      tokens: 7,
    });
    expect(log.events).toHaveLength(1);
  });

  it('throws on a forbidden record key with a string value, and allows a number', () => {
    const log = new FakeLog();
    expect(() => {
      log.info('thread.classified', { headers: { authorization: 'x' } });
    }).toThrow(/forbidden field "authorization"/);
    log.info('thread.classified', { probabilities: { password: 0.9 } });
    expect(log.events).toHaveLength(1);
  });
});
