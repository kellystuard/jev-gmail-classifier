import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/loader.ts';
import { ConfigError, JevClassifierError } from '../../src/core/errors.ts';

const MARKER = 'PRIVATE-MARKER-7f3a';

function valid(): Record<string, unknown> {
  return {
    defaultThreshold: 0.8,
    rules: [
      { id: 'bill', question: 'Is this email a bill?', label: 'Finance/Bill' },
      {
        id: 'newsletter',
        question: 'Is this a newsletter?',
        action: 'move',
        destination: 'label:Newsletters',
        threshold: 0.95,
      },
    ],
  };
}

/**
 * A plain property assignment. `readonly` doesn't affect assignability, so the
 * frozen config can be passed here to show the runtime freeze. Test files are
 * ES modules, so this runs in strict mode.
 */
function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  target[key] = value;
}

/** Runs `fn` and returns what it threw, failing if it didn't throw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('loadConfig', () => {
  it('returns the parsed config, with defaults and the destination transform applied', () => {
    expect(loadConfig(valid())).toEqual({
      defaultThreshold: 0.8,
      triggerIntervalMinutes: 10,
      jevModel: 'jev-latest',
      dailyTokenBudget: 20_000_000,
      plainTextMethod: 'basic',
      rules: [
        { id: 'bill', question: 'Is this email a bill?', action: 'label', label: 'Finance/Bill' },
        {
          id: 'newsletter',
          question: 'Is this a newsletter?',
          action: 'move',
          destination: { kind: 'label', label: 'Newsletters' },
          threshold: 0.95,
        },
      ],
    });
  });

  it('freezes the config, its rules, each rule and each destination', () => {
    const config = loadConfig(valid());
    const move = config.rules[1];
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.rules)).toBe(true);
    expect(Object.isFrozen(config.rules[0])).toBe(true);
    expect(move?.action).toBe('move');
    expect(Object.isFrozen(move?.action === 'move' ? move.destination : undefined)).toBe(true);
  });

  it('throws TypeError on assignment, since modules run in strict mode', () => {
    const config = loadConfig(valid());
    expect(() => {
      assign(config, 'defaultThreshold', 0.1);
    }).toThrow(TypeError);
    expect(() => {
      Object.assign(config.rules[0] ?? {}, { label: 'Other' });
    }).toThrow(TypeError);
    expect(() => {
      Array.prototype.push.call(config.rules, {});
    }).toThrow(TypeError);
  });

  it('does not freeze or change its input', () => {
    const raw = valid();
    loadConfig(raw);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(raw).toEqual(valid());
  });

  it('throws ConfigError listing every issue by path', () => {
    const raw = { ...valid(), defaultThreshold: 2, jevModel: '' };
    const error = thrownBy(() => loadConfig(raw));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toBeInstanceOf(JevClassifierError);
    if (error instanceof ConfigError) {
      expect(error.issues).toEqual([
        { path: 'defaultThreshold', message: 'must be a number from 0 to 1' },
        {
          path: 'jevModel',
          message: 'must be a Jev model name such as jev-latest or jev-1.13.0',
        },
      ]);
      expect(error.message).toContain('defaultThreshold: must be a number from 0 to 1');
      expect(error.message).toContain('jevModel: must be a Jev model name');
    }
  });

  it('never quotes excludeQuery or a question', () => {
    const raw = {
      ...valid(),
      defaultThreshold: 2,
      excludeQuery: [`from:${MARKER}.example`],
      rules: [{ id: 'bill', question: { text: `Is this from ${MARKER}?` }, label: 'Bill' }],
    };
    const error = thrownBy(() => loadConfig(raw));
    expect(error).toBeInstanceOf(ConfigError);
    if (error instanceof ConfigError) {
      expect(error.issues.map((issue) => issue.path)).toEqual([
        'defaultThreshold',
        'excludeQuery',
        'rules[0].question',
      ]);
      expect(error.message).not.toContain(MARKER);
      expect(JSON.stringify(error.issues)).not.toContain(MARKER);
      expect(JSON.stringify(error.toLogFields())).not.toContain(MARKER);
    }
  });

  it.each([undefined, null, 'defaultThreshold: 0.8', 42, []])(
    'throws ConfigError, not TypeError, for %j',
    (raw) => {
      const error = thrownBy(() => loadConfig(raw));
      expect(error).toBeInstanceOf(ConfigError);
      if (error instanceof ConfigError) {
        expect(error.issues.map((issue) => issue.path)).toEqual(['']);
        expect(error.message).toMatch(/^Invalid config:\n\(root\): must be a set of settings/);
      }
    },
  );
});
