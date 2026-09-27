import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  configIssues,
  configSchema,
  labelKey,
  RESERVED_LABEL_NAMES,
  type Config,
  type ConfigInput,
  type LabelRule,
  type MoveDestination,
  type MoveRule,
} from '../../src/config/schema.ts';
import { ConfigError, type ConfigIssue } from '../../src/core/errors.ts';

// The messages, as the user sees them after the field path.
const THRESHOLD = 'must be a number from 0 to 1';
const TRIGGER_INTERVAL = 'must be 1, 5, 10, 15 or 30 (the intervals Apps Script supports)';
const JEV_MODEL = 'must be a Jev model name such as jev-latest or jev-1.13.0';
const TOKEN_BUDGET = 'must be a whole number of tokens, at least 1';
const EXCLUDE_QUERY = 'must be a Gmail search query; delete the line to exclude nothing';
const PLAIN_TEXT_METHOD = 'must be basic';
const PLAIN_TEXT_ADVANCED = 'advanced is reserved for a future version; use basic';
const RULES = 'add at least one rule';
const RULE = 'must be a rule with an id, a question, and a label or destination';
const RULE_ID =
  'must start with a lowercase letter and use only a-z, 0-9, - and _ (at most 32 characters)';
const QUESTION = 'must be a yes/no question';
const ACTION = 'must be label or move';
const LABEL = 'must be a label name, such as Finance/Bill';
const DESTINATION = 'must be archive, spam, trash or label:<name>';
const LABEL_REQUIRED = 'required when action is label';
const LABEL_WITH_MOVE =
  'only allowed when action is label; for a move to a label, use destination: label:<name>';
const DESTINATION_REQUIRED = 'required when action is move';
const DESTINATION_WITH_LABEL = 'only allowed when action is move';
const UNKNOWN_FIELD = 'unknown field; check the spelling against config.example.yaml';
const NOT_A_MAPPING =
  'must be a set of settings such as defaultThreshold and rules; see config.example.yaml';
const LABEL_PART = 'each part between / must be non-empty, with no spaces at either end';
const JEV_NAMESPACE = 'labels under Jev/ are reserved for the classifier (Jev/Error)';

type Raw = Record<string, unknown>;

const LABEL_RULE: Raw = { id: 'bill', question: 'Is this email a bill or invoice?', label: 'Bill' };

/** A valid config, with fields replaced or (when `undefined`) removed. */
function config(overrides: Raw = {}): Raw {
  const out: Raw = { defaultThreshold: 0.8, rules: [LABEL_RULE] };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete out[key];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** A valid config whose only rule is `LABEL_RULE` changed the same way. */
function withRule(overrides: Raw): Raw {
  const rule: Raw = { ...LABEL_RULE };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete rule[key];
    } else {
      rule[key] = value;
    }
  }
  return config({ rules: [rule] });
}

function moveRule(destination: unknown, id = 'move'): Raw {
  return { id, question: 'Should this email move?', action: 'move', destination };
}

function issues(input: unknown): ConfigIssue[] {
  const result = configSchema.safeParse(input);
  return result.success ? [] : configIssues(result.error);
}

function parse(input: unknown): Config {
  return configSchema.parse(input);
}

describe('a valid config', () => {
  it('parses a full example and applies no defaults over given values', () => {
    const input: ConfigInput = {
      defaultThreshold: 0.8,
      triggerIntervalMinutes: 15,
      jevModel: 'jev-1.13.0',
      dailyTokenBudget: 1000,
      excludeQuery: 'from:mybank.com OR label:Private',
      plainTextMethod: 'basic',
      rules: [
        { id: 'approval', question: 'Does this ask for approval?', label: 'Approval Required' },
        { id: 'bill', question: 'Is this a bill?', action: 'label', label: 'Finance/Bill', threshold: 0.9 },
        { id: 'marketing', question: 'Is this marketing?', action: 'move', destination: 'spam', threshold: 0.95 },
      ],
    };
    expect(parse(input)).toEqual({
      defaultThreshold: 0.8,
      triggerIntervalMinutes: 15,
      jevModel: 'jev-1.13.0',
      dailyTokenBudget: 1000,
      excludeQuery: 'from:mybank.com OR label:Private',
      plainTextMethod: 'basic',
      rules: [
        { id: 'approval', question: 'Does this ask for approval?', action: 'label', label: 'Approval Required' },
        { id: 'bill', question: 'Is this a bill?', action: 'label', label: 'Finance/Bill', threshold: 0.9 },
        {
          id: 'marketing',
          question: 'Is this marketing?',
          action: 'move',
          destination: { kind: 'spam' },
          threshold: 0.95,
        },
      ],
    });
  });

  it('applies every default to a minimal config', () => {
    expect(parse(config())).toEqual({
      defaultThreshold: 0.8,
      triggerIntervalMinutes: 10,
      jevModel: 'jev-latest',
      dailyTokenBudget: 20_000_000,
      plainTextMethod: 'basic',
      rules: [{ id: 'bill', question: 'Is this email a bill or invoice?', action: 'label', label: 'Bill' }],
    });
  });

  it('leaves excludeQuery and a rule threshold absent rather than filling them in', () => {
    const parsed = parse(config());
    expect('excludeQuery' in parsed).toBe(false);
    expect('threshold' in (parsed.rules[0] ?? {})).toBe(false);
  });

  it('emits a JSON Schema for editors without throwing', () => {
    expect(() => z.toJSONSchema(configSchema, { io: 'input', target: 'draft-7' })).not.toThrow();
  });

  it('types rules as a union discriminated on action', () => {
    expectTypeOf<Config['rules'][number]>().toEqualTypeOf<LabelRule | MoveRule>();
    expectTypeOf<Config['rules']>().toMatchTypeOf<readonly unknown[]>();
  });
});

describe('top-level fields', () => {
  it.each([
    ['defaultThreshold', 0],
    ['defaultThreshold', 0.5],
    ['defaultThreshold', 1],
    ['triggerIntervalMinutes', 1],
    ['triggerIntervalMinutes', 5],
    ['triggerIntervalMinutes', 10],
    ['triggerIntervalMinutes', 15],
    ['triggerIntervalMinutes', 30],
    ['jevModel', 'jev-latest'],
    ['jevModel', 'jev-1.13.0'],
    ['dailyTokenBudget', 1],
    ['dailyTokenBudget', 20_000_000],
    ['dailyTokenBudget', Number.MAX_SAFE_INTEGER],
    ['excludeQuery', 'from:mybank.com OR label:Private'],
    ['excludeQuery', '-{from:a.example}'],
    ['plainTextMethod', 'basic'],
  ])('accepts %s: %j', (field, value) => {
    const parsed: Readonly<Record<string, unknown>> = parse(config({ [field]: value }));
    expect(parsed[field]).toBe(value);
  });

  it.each([
    ['triggerIntervalMinutes', 10],
    ['jevModel', 'jev-latest'],
    ['dailyTokenBudget', 20_000_000],
    ['plainTextMethod', 'basic'],
  ])('defaults %s to %j', (field, value) => {
    const parsed: Readonly<Record<string, unknown>> = parse(config({ [field]: undefined }));
    expect(parsed[field]).toBe(value);
  });

  it.each([
    ['defaultThreshold', undefined, THRESHOLD],
    ['defaultThreshold', -0.01, THRESHOLD],
    ['defaultThreshold', 1.01, THRESHOLD],
    ['defaultThreshold', '0.8', THRESHOLD],
    ['defaultThreshold', null, THRESHOLD],
    ['defaultThreshold', Number.NaN, THRESHOLD],
    ['triggerIntervalMinutes', 0, TRIGGER_INTERVAL],
    ['triggerIntervalMinutes', 7, TRIGGER_INTERVAL],
    ['triggerIntervalMinutes', 60, TRIGGER_INTERVAL],
    ['triggerIntervalMinutes', '10', TRIGGER_INTERVAL],
    ['triggerIntervalMinutes', null, TRIGGER_INTERVAL],
    ['jevModel', '', JEV_MODEL],
    ['jevModel', 'jev latest', JEV_MODEL],
    ['jevModel', ' jev-latest', JEV_MODEL],
    ['jevModel', 1.13, JEV_MODEL],
    ['jevModel', null, JEV_MODEL],
    ['dailyTokenBudget', 0, TOKEN_BUDGET],
    ['dailyTokenBudget', -1, TOKEN_BUDGET],
    ['dailyTokenBudget', 1.5, TOKEN_BUDGET],
    ['dailyTokenBudget', Number.MAX_SAFE_INTEGER + 1, TOKEN_BUDGET],
    ['dailyTokenBudget', Number.POSITIVE_INFINITY, TOKEN_BUDGET],
    ['dailyTokenBudget', '20000000', TOKEN_BUDGET],
    ['dailyTokenBudget', null, TOKEN_BUDGET],
    ['excludeQuery', null, EXCLUDE_QUERY],
    ['excludeQuery', '', EXCLUDE_QUERY],
    ['excludeQuery', '   ', EXCLUDE_QUERY],
    ['excludeQuery', 42, EXCLUDE_QUERY],
    ['plainTextMethod', 'advanced', PLAIN_TEXT_ADVANCED],
    ['plainTextMethod', 'Basic', PLAIN_TEXT_METHOD],
    ['plainTextMethod', 'fancy', PLAIN_TEXT_METHOD],
    ['plainTextMethod', null, PLAIN_TEXT_METHOD],
    ['rules', undefined, RULES],
    ['rules', [], RULES],
    ['rules', null, RULES],
    ['rules', 'bill', RULES],
  ])('rejects %s: %j', (field, value, message) => {
    expect(issues(config({ [field]: value }))).toEqual([{ path: field, message }]);
  });

  it('rejects an unknown top-level key such as a misspelled field', () => {
    expect(issues(config({ treshold: 0.5 }))).toEqual([{ path: 'treshold', message: UNKNOWN_FIELD }]);
  });

  it.each([null, 'defaultThreshold: 0.8', [config()]])('rejects a file that is not a mapping: %j', (input) => {
    expect(issues(input)).toEqual([{ path: '', message: NOT_A_MAPPING }]);
  });

  it('gives issues that ConfigError prints as one <path>: <message> line each', () => {
    const result = configSchema.safeParse(withRule({ id: 'Bill', treshold: 0.9 }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(new ConfigError(configIssues(result.error)).message).toBe(
        ['Invalid config:', `rules[0].id: ${RULE_ID}`, `rules[0].treshold: ${UNKNOWN_FIELD}`].join('\n'),
      );
    }
    const root = configSchema.safeParse(null);
    expect(root.success).toBe(false);
    if (!root.success) {
      expect(new ConfigError(configIssues(root.error)).message).toBe(
        `Invalid config:\n(root): ${NOT_A_MAPPING}`,
      );
    }
  });

  it('reports every problem in one pass', () => {
    expect(issues(config({ defaultThreshold: 2, jevModel: '', rules: [] }))).toEqual([
      { path: 'defaultThreshold', message: THRESHOLD },
      { path: 'jevModel', message: JEV_MODEL },
      { path: 'rules', message: RULES },
    ]);
  });
});

describe('rule fields', () => {
  it.each([
    ['id', 'a'],
    ['id', 'bill'],
    ['id', 'bill-2_x'],
    ['id', 'a'.repeat(32)],
    ['question', 'Is this email a bill or invoice?'],
    ['threshold', 0],
    ['threshold', 0.95],
    ['threshold', 1],
  ])('accepts %s: %j', (field, value) => {
    const rule: Readonly<Record<string, unknown>> | undefined = parse(withRule({ [field]: value })).rules[0];
    expect(rule?.[field]).toBe(value);
  });

  it('defaults action to label', () => {
    expect(parse(withRule({ action: undefined })).rules[0]?.action).toBe('label');
  });

  it('accepts an explicit action: label', () => {
    expect(parse(withRule({ action: 'label' })).rules[0]?.action).toBe('label');
  });

  it.each([
    ['id', undefined, RULE_ID],
    ['id', 'Bill', RULE_ID],
    ['id', '1bill', RULE_ID],
    ['id', 'bill id', RULE_ID],
    ['id', '-bill', RULE_ID],
    ['id', '', RULE_ID],
    ['id', 'a'.repeat(33), RULE_ID],
    ['id', 7, RULE_ID],
    ['question', undefined, QUESTION],
    ['question', '', QUESTION],
    ['question', '  ', QUESTION],
    ['question', 5, QUESTION],
    ['action', 'Label', ACTION],
    ['action', 'copy', ACTION],
    ['action', null, ACTION],
    ['label', 5, LABEL],
    ['label', null, LABEL],
    ['threshold', -0.01, THRESHOLD],
    ['threshold', 1.01, THRESHOLD],
    ['threshold', '0.9', THRESHOLD],
    ['threshold', null, THRESHOLD],
  ])('rejects %s: %j', (field, value, message) => {
    expect(issues(withRule({ [field]: value }))).toEqual([{ path: `rules[0].${field}`, message }]);
  });

  it('rejects a rule that is not a mapping', () => {
    expect(issues(config({ rules: ['bill'] }))).toEqual([{ path: 'rules[0]', message: RULE }]);
  });

  it('rejects an unknown key in a rule', () => {
    expect(issues(withRule({ treshold: 0.9 }))).toEqual([
      { path: 'rules[0].treshold', message: UNKNOWN_FIELD },
    ]);
  });

  it('rejects a duplicate id at the later rule', () => {
    const rules = [LABEL_RULE, { ...LABEL_RULE, label: 'Other' }, { ...LABEL_RULE, id: 'x' }, LABEL_RULE];
    expect(issues(config({ rules }))).toEqual([
      { path: 'rules[1].id', message: 'duplicate rule id "bill"; also used by rules[0]' },
      { path: 'rules[3].id', message: 'duplicate rule id "bill"; also used by rules[0]' },
    ]);
  });

  it('never quotes a question or the excludeQuery in a message', () => {
    const secret = 'Is this from my divorce lawyer?';
    const result = issues(
      config({
        excludeQuery: { query: secret },
        rules: [{ id: 'x', question: [secret], label: 5 }],
      }),
    );
    expect(result.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('divorce');
  });
});

describe('label and destination', () => {
  it('requires label when action is label', () => {
    expect(issues(withRule({ label: undefined }))).toEqual([{ path: 'rules[0].label', message: LABEL_REQUIRED }]);
  });

  it('rejects destination when action is label', () => {
    expect(issues(withRule({ destination: 'archive' }))).toEqual([
      { path: 'rules[0].destination', message: DESTINATION_WITH_LABEL },
    ]);
  });

  it('requires destination when action is move', () => {
    expect(issues(config({ rules: [moveRule(undefined)] }))).toEqual([
      { path: 'rules[0].destination', message: DESTINATION_REQUIRED },
    ]);
  });

  it('rejects label when action is move', () => {
    expect(issues(config({ rules: [{ ...moveRule('archive'), label: 'Bill' }] }))).toEqual([
      { path: 'rules[0].label', message: LABEL_WITH_MOVE },
    ]);
  });

  it.each<[string, MoveDestination]>([
    ['archive', { kind: 'archive' }],
    ['spam', { kind: 'spam' }],
    ['trash', { kind: 'trash' }],
    ['label:Receipts', { kind: 'label', label: 'Receipts' }],
    ['label:Finance/Bill', { kind: 'label', label: 'Finance/Bill' }],
    ['label:Approval Required', { kind: 'label', label: 'Approval Required' }],
  ])('parses destination %j into a MoveDestination', (destination, expected) => {
    const rule = parse(config({ rules: [moveRule(destination)] })).rules[0];
    expect(rule).toEqual({ id: 'move', question: 'Should this email move?', action: 'move', destination: expected });
  });

  it.each([
    ['Archive', DESTINATION],
    ['SPAM', DESTINATION],
    ['delete', DESTINATION],
    ['inbox', DESTINATION],
    ['label', DESTINATION],
    ['Label:Receipts', DESTINATION],
    ['', DESTINATION],
    [5, DESTINATION],
    [null, DESTINATION],
    ['label:', LABEL_PART],
    ['label: X', LABEL_PART],
    ['label:X ', LABEL_PART],
  ])('rejects destination %j', (destination, message) => {
    expect(issues(config({ rules: [moveRule(destination)] }))).toEqual([
      { path: 'rules[0].destination', message },
    ]);
  });
});

/**
 * Each label-name case from `spikes/25-nested-labels.md`, checked both as a
 * label rule's `label` and as a move rule's `destination: label:<name>`.
 */
const AS_LABEL = { field: 'label', rule: (name: string): Raw => ({ ...LABEL_RULE, label: name }) };
const AS_DESTINATION = { field: 'destination', rule: (name: string): Raw => moveRule(`label:${name}`) };

describe.each([
  ['as label', AS_LABEL],
  ['as destination', AS_DESTINATION],
])('label names %s', (_, form) => {
  function nameIssues(name: string): ConfigIssue[] {
    return issues(config({ rules: [form.rule(name)] }));
  }

  it.each(['Bill', 'Finance/Bill', 'Social', 'social', 'Work/Inbox', 'Work/Spam/Old', 'Jevons', 'Projects/Jev'])(
    'accepts %j',
    (name) => {
      expect(nameIssues(name)).toEqual([]);
    },
  );

  it.each([...RESERVED_LABEL_NAMES, 'INBOX', 'inbox', 'sPaM'])('rejects the system label %j', (name) => {
    expect(nameIssues(name)).toEqual([
      { path: `rules[0].${form.field}`, message: `"${name}" is a Gmail system label; choose another name` },
    ]);
  });

  it.each([
    ['Inbox/X', 'Inbox'],
    ['Spam/X', 'Spam'],
    ['inbox/Receipts', 'Inbox'],
    ['TRASH/Old/Stuff', 'Trash'],
  ])('rejects %j under the system label %s', (name, system) => {
    expect(nameIssues(name)).toEqual([
      {
        path: `rules[0].${form.field}`,
        message: `Gmail would show "${name}" as a separate label, not under the system ${system} label; choose another top-level name`,
      },
    ]);
  });

  it.each(['A/', '/A', 'A//B', 'A / B', 'A/ B', ' A', 'A ', '/'])('rejects the empty or padded part in %j', (name) => {
    expect(nameIssues(name)).toEqual([{ path: `rules[0].${form.field}`, message: LABEL_PART }]);
  });

  it.each(['Jev', 'Jev/Error', 'jev/x', 'JEV/Other/Deep'])('rejects %j in the reserved Jev namespace', (name) => {
    expect(nameIssues(name)).toEqual([{ path: `rules[0].${form.field}`, message: JEV_NAMESPACE }]);
  });

  it('rejects a name that differs only in case from an earlier rule, at the later rule', () => {
    const rules = [{ ...LABEL_RULE, id: 'first', label: 'Finance/Bill' }, form.rule('finance/bill')];
    expect(issues(config({ rules }))).toEqual([
      {
        path: `rules[1].${form.field}`,
        message:
          'label "finance/bill" differs only in case from "Finance/Bill" in rules[0]; Gmail treats them as one label',
      },
    ]);
  });

  it('rejects a case-only collision with an earlier move destination', () => {
    const rules = [moveRule('label:Finance/Bill', 'first'), form.rule('FINANCE/BILL')];
    expect(issues(config({ rules }))).toEqual([
      {
        path: `rules[1].${form.field}`,
        message:
          'label "FINANCE/BILL" differs only in case from "Finance/Bill" in rules[0]; Gmail treats them as one label',
      },
    ]);
  });

  it('accepts the same name written identically in two rules', () => {
    const rules = [{ ...LABEL_RULE, id: 'first', label: 'Finance' }, form.rule('Finance')];
    expect(issues(config({ rules }))).toEqual([]);
  });
});

describe('labelKey', () => {
  it('is exported from the schema module for the label cache (E6)', () => {
    expect(labelKey('Finance / Bill')).toBe('finance/bill');
  });
});
