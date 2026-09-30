/**
 * Builds the body of a Jev request (Solution Design §8.2, ADR-0010): the model,
 * the thread's `state` and one Noul question per rule, keyed by the rule's id.
 * Pure `core/` code. It adds no header and never sees the API key: the sender
 * and the probe add `Authorization` and serialize the body.
 */
import { InvalidArgumentError } from './errors.ts';
import type { JevStateMessage } from './jev-state.ts';

/** SD §8.2. A constant, never config. */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export type JevQuestion = { readonly type: 'noul'; readonly instructions: string };

export type JevRequestBody = {
  readonly model: string;
  readonly state: readonly JevStateMessage[];
  readonly questions: Readonly<Record<string, JevQuestion>>;
};

/** Plain values, not `Config`, like `threadToState`. E7 passes `config.jevModel` and `config.rules`. */
export interface BuildRequestOptions {
  readonly model: string;
  readonly rules: readonly { readonly id: string; readonly question: string }[];
}

/**
 * Returns `{model, state, questions}`, in that key order, with every rule as a
 * question in config order. `state` is passed through, not copied.
 *
 * @throws InvalidArgumentError for a blank model, no rules, a duplicate rule id
 *   or an empty `state`. These are caller bugs. The error never carries a
 *   question's text or any of `state`.
 */
export function buildRequest(
  options: BuildRequestOptions,
  state: readonly JevStateMessage[],
): JevRequestBody {
  const { model, rules } = options;
  if (model.trim() === '') {
    throw new InvalidArgumentError('model must not be blank', {
      argument: 'model',
      reason: 'blank',
    });
  }
  if (rules.length === 0) {
    throw new InvalidArgumentError('rules must not be empty', {
      argument: 'rules',
      reason: 'empty',
    });
  }
  if (state.length === 0) {
    throw new InvalidArgumentError('state must not be empty', {
      argument: 'state',
      reason: 'empty',
    });
  }
  const questions: Record<string, JevQuestion> = {};
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new InvalidArgumentError(`rules contains a duplicate id: ${rule.id}`, {
        argument: 'rules',
        reason: 'duplicate_id',
      });
    }
    seen.add(rule.id);
    questions[rule.id] = { type: 'noul', instructions: rule.question };
  }
  return { model, state, questions };
}
