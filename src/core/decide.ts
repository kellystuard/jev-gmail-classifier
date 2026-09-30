/**
 * Decides a thread's outcome from Jev's answers (Solution Design §6.5, "Decide").
 * Pure: no logging, no state, and the inputs are never mutated.
 */
import { labelKey } from '../config/labels.ts';
import type { Config, MoveDestination } from '../config/schema.ts';
import { InvalidArgumentError } from './errors.ts';
import type { JevAnswers } from './jev-response.ts';
import type { WorkItem } from './work-queue.ts';

/** Plain values, not the whole Config. */
export type DecideConfig = {
  readonly rules: Config['rules'];
  readonly defaultThreshold: number;
};

export type Decision = {
  /** Every firing rule id, label and move rules, in config order. */
  readonly fired: readonly string[];
  /** Firing label rules' labels, config order, de-duplicated by labelKey (first spelling wins). */
  readonly labels: readonly string[];
  /** Absent (not `undefined`) when no move applies. */
  readonly move?: { readonly ruleId: string; readonly destination: MoveDestination };
};

function answerFor(answers: JevAnswers, ruleId: string): number {
  const value = Object.prototype.hasOwnProperty.call(answers, ruleId) ? answers[ruleId] : undefined;
  if (value === undefined) {
    throw new InvalidArgumentError(`No answer for rule "${ruleId}"`, {
      argument: 'answers',
      reason: `answer for rule "${ruleId}" is missing`,
    });
  }
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) {
    throw new InvalidArgumentError(`Answer for rule "${ruleId}" is not a probability`, {
      argument: 'answers',
      reason: `answer for rule "${ruleId}" is outside 0..1`,
    });
  }
  return value;
}

export function decideOutcome(
  config: DecideConfig,
  answers: JevAnswers,
  options: { readonly movesAllowed: boolean },
): Decision {
  // Validate every rule's answer before deciding anything.
  const probabilities = config.rules.map((rule) => answerFor(answers, rule.id));

  const fired: string[] = [];
  const labels: string[] = [];
  const seen = new Set<string>();
  let move: { ruleId: string; destination: MoveDestination } | undefined;

  config.rules.forEach((rule, index) => {
    const probability = probabilities[index];
    if (probability === undefined || probability < (rule.threshold ?? config.defaultThreshold)) {
      return;
    }
    fired.push(rule.id);
    if (rule.action === 'label') {
      const key = labelKey(rule.label);
      if (!seen.has(key)) {
        seen.add(key);
        labels.push(rule.label);
      }
    } else if (options.movesAllowed && move === undefined) {
      move = { ruleId: rule.id, destination: rule.destination };
    }
  });

  return move === undefined ? { fired, labels } : { fired, labels, move };
}

/** A first classification, or a manual job that asked for moves. Unset counts as false. */
export function movesAllowed(item: Pick<WorkItem, 'firstClassification' | 'applyMoves'>): boolean {
  return item.firstClassification === true || item.applyMoves === true;
}
