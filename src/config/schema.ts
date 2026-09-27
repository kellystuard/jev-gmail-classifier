/**
 * The one schema for `config.yaml` (Solution Design §7.2, ADR-0013). The build
 * validates the YAML with it, and the script validates the embedded copy again
 * when it loads.
 *
 * Messages never quote the value of `excludeQuery` or a `question`: both can
 * describe private mail, and the runtime puts these messages into a logged
 * exception. Rule IDs and label names may appear.
 */
import { z } from 'zod';

import type { DeepReadonly } from './deep-readonly.ts';
import { labelKey, labelNameProblem } from './labels.ts';

export { labelKey, RESERVED_LABEL_NAMES } from './labels.ts';
export { configIssues } from './issues.ts';
export type { DeepReadonly } from './deep-readonly.ts';

/** Where a move rule sends the thread. The schema parses `destination` into this. */
export type MoveDestination =
  | { readonly kind: 'archive' }
  | { readonly kind: 'spam' }
  | { readonly kind: 'trash' }
  | { readonly kind: 'label'; readonly label: string };

/** A rule that adds a label when it fires. */
export interface LabelRule {
  readonly id: string;
  readonly question: string;
  readonly action: 'label';
  readonly label: string;
  /** Absent means `defaultThreshold` applies when deciding (SD §6.5). */
  readonly threshold?: number;
}

/** A rule that moves the thread when it fires. */
export interface MoveRule {
  readonly id: string;
  readonly question: string;
  readonly action: 'move';
  readonly destination: MoveDestination;
  /** Absent means `defaultThreshold` applies when deciding (SD §6.5). */
  readonly threshold?: number;
}

export type Rule = LabelRule | MoveRule;

/** Starts with a lowercase letter, then a-z, 0-9, `-` or `_`; 1 to 32 characters. */
const RULE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** The time-driven trigger intervals Apps Script supports, in minutes. */
const TRIGGER_INTERVALS = [1, 5, 10, 15, 30] as const;

const UNKNOWN_FIELD = 'unknown field; check the spelling against config.example.yaml';
const THRESHOLD = 'must be a number from 0 to 1';
const TRIGGER_INTERVAL = 'must be 1, 5, 10, 15 or 30 (the intervals Apps Script supports)';
const JEV_MODEL = 'must be a Jev model name such as jev-latest or jev-1.13.0';
const TOKEN_BUDGET = 'must be a whole number of tokens, at least 1';
const EXCLUDE_QUERY = 'must be a Gmail search query; delete the line to exclude nothing';
const PLAIN_TEXT_METHOD = 'must be basic';
const PLAIN_TEXT_ADVANCED = 'advanced is reserved for a future version; use basic';
const RULES = 'add at least one rule';
const RULE = 'must be a rule with an id, a question, and a label or destination';
const RULE_ID = 'must start with a lowercase letter and use only a-z, 0-9, - and _ (at most 32 characters)';
const QUESTION = 'must be a yes/no question';
const ACTION = 'must be label or move';
const LABEL = 'must be a label name, such as Finance/Bill';
const DESTINATION = 'must be archive, spam, trash or label:<name>';
const LABEL_REQUIRED = 'required when action is label';
const LABEL_WITH_MOVE =
  'only allowed when action is label; for a move to a label, use destination: label:<name>';
const DESTINATION_REQUIRED = 'required when action is move';
const DESTINATION_WITH_LABEL = 'only allowed when action is move';

const LABEL_DESTINATION_PREFIX = 'label:';

const thresholdSchema = z
  .number({ error: THRESHOLD })
  .min(0, { error: THRESHOLD })
  .max(1, { error: THRESHOLD });

function nonBlankString(message: string) {
  return z.string({ error: message }).refine((value) => value.trim() !== '', { error: message });
}

const labelNameSchema = z.string({ error: LABEL }).superRefine((name, ctx) => {
  const problem = labelNameProblem(name);
  if (problem !== undefined) {
    ctx.addIssue({ code: 'custom', message: problem });
  }
});

const destinationSchema = z
  .string({ error: DESTINATION })
  .transform((value, ctx): MoveDestination => {
    if (value === 'archive' || value === 'spam' || value === 'trash') {
      return { kind: value };
    }
    if (value.startsWith(LABEL_DESTINATION_PREFIX)) {
      const label = value.slice(LABEL_DESTINATION_PREFIX.length);
      const problem = labelNameProblem(label);
      if (problem === undefined) {
        return { kind: 'label', label };
      }
      ctx.addIssue({ code: 'custom', message: problem });
      return z.NEVER;
    }
    ctx.addIssue({ code: 'custom', message: DESTINATION });
    return z.NEVER;
  });

const ruleSchema = z
  .strictObject(
    {
      id: z.string({ error: RULE_ID }).regex(RULE_ID_PATTERN, { error: RULE_ID }),
      question: nonBlankString(QUESTION),
      action: z.enum(['label', 'move'], { error: ACTION }).default('label'),
      label: labelNameSchema.optional(),
      destination: destinationSchema.optional(),
      threshold: thresholdSchema.optional(),
    },
    { error: (issue) => (issue.code === 'unrecognized_keys' ? UNKNOWN_FIELD : RULE) },
  )
  .superRefine((rule: { action?: unknown; label?: unknown; destination?: unknown }, ctx) => {
    // Zod also runs this when a field failed with a non-fatal issue, and then
    // the fields hold raw input. So it trusts nothing, and reports every
    // cross-field problem in the same pass as the field problems.
    if (rule.action === 'label') {
      if (rule.label === undefined) {
        ctx.addIssue({ code: 'custom', path: ['label'], message: LABEL_REQUIRED });
      }
      if (rule.destination !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['destination'], message: DESTINATION_WITH_LABEL });
      }
    } else if (rule.action === 'move') {
      if (rule.destination === undefined) {
        ctx.addIssue({ code: 'custom', path: ['destination'], message: DESTINATION_REQUIRED });
      }
      if (rule.label !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['label'], message: LABEL_WITH_MOVE });
      }
    }
  })
  .transform((rule): Rule => {
    // Zod runs this only when the rule has no issues, so the refinement above
    // guarantees the field each action needs.
    const threshold = rule.threshold === undefined ? {} : { threshold: rule.threshold };
    if (rule.action === 'label') {
      if (rule.label === undefined) {
        throw new Error('invalid state: a label rule without a label passed validation');
      }
      return { id: rule.id, question: rule.question, action: 'label', label: rule.label, ...threshold };
    }
    if (rule.destination === undefined) {
      throw new Error('invalid state: a move rule without a destination passed validation');
    }
    return {
      id: rule.id,
      question: rule.question,
      action: 'move',
      destination: rule.destination,
      ...threshold,
    };
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The label a parsed rule adds, with the field it came from. Returns
 * `undefined` for a rule that didn't parse: Zod still runs the array check
 * when one rule has a non-fatal issue, and then that element is the raw input.
 */
function ruleLabel(rule: unknown): { label: string; field: 'label' | 'destination' } | undefined {
  if (!isRecord(rule)) {
    return undefined;
  }
  let found: { label: string; field: 'label' | 'destination' } | undefined;
  if (rule['action'] === 'label' && typeof rule['label'] === 'string') {
    found = { label: rule['label'], field: 'label' };
  }
  const destination = rule['destination'];
  if (
    rule['action'] === 'move' &&
    isRecord(destination) &&
    destination['kind'] === 'label' &&
    typeof destination['label'] === 'string'
  ) {
    found = { label: destination['label'], field: 'destination' };
  }
  return found !== undefined && labelNameProblem(found.label) === undefined ? found : undefined;
}

const rulesSchema = z
  .array(ruleSchema, { error: RULES })
  .min(1, { error: RULES })
  .superRefine((rules: readonly unknown[], ctx) => {
    const firstById = new Map<string, number>();
    const firstByLabelKey = new Map<string, { label: string; index: number }>();
    rules.forEach((rule, index) => {
      const id = isRecord(rule) ? rule['id'] : undefined;
      if (typeof id === 'string') {
        const first = firstById.get(id);
        if (first === undefined) {
          firstById.set(id, index);
        } else {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'id'],
            message: `duplicate rule id "${id}"; also used by rules[${String(first)}]`,
          });
        }
      }

      const found = ruleLabel(rule);
      if (found !== undefined) {
        const key = labelKey(found.label);
        const first = firstByLabelKey.get(key);
        if (first === undefined) {
          firstByLabelKey.set(key, { label: found.label, index });
        } else if (first.label !== found.label) {
          ctx.addIssue({
            code: 'custom',
            path: [index, found.field],
            message: `label "${found.label}" differs only in case from "${first.label}" in rules[${String(first.index)}]; Gmail treats them as one label`,
          });
        }
      }
    });
  });

/** The `config.yaml` schema. Unknown keys are rejected at every level. */
export const configSchema = z.strictObject(
  {
    defaultThreshold: thresholdSchema,
    triggerIntervalMinutes: z.literal(TRIGGER_INTERVALS, { error: TRIGGER_INTERVAL }).default(10),
    jevModel: z
      .string({ error: JEV_MODEL })
      .regex(/^\S+$/, { error: JEV_MODEL })
      .default('jev-latest'),
    // Zod's `int()` also caps the value at `Number.MAX_SAFE_INTEGER`.
    dailyTokenBudget: z
      .number({ error: TOKEN_BUDGET })
      .int({ error: TOKEN_BUDGET })
      .min(1, { error: TOKEN_BUDGET })
      .default(20_000_000),
    excludeQuery: nonBlankString(EXCLUDE_QUERY).optional(),
    plainTextMethod: z
      .literal('basic', {
        error: (issue) => (issue.input === 'advanced' ? PLAIN_TEXT_ADVANCED : PLAIN_TEXT_METHOD),
      })
      .default('basic'),
    rules: rulesSchema,
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? UNKNOWN_FIELD
        : 'must be a set of settings such as defaultThreshold and rules; see config.example.yaml',
  },
);

/** The config as written in `config.yaml`, before defaults and parsing. */
export type ConfigInput = z.input<typeof configSchema>;

/** The validated config, with defaults applied. `loadConfig` freezes it to match. */
export type Config = DeepReadonly<z.output<typeof configSchema>>;
