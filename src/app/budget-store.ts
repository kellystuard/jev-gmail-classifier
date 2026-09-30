/**
 * Reads and writes `state.budget` over `StatePort` (Solution Design §7.3,
 * §10.2; epic #11 decisions 1 and 10). The codec and the pure functions are in
 * `src/core/token-budget.ts`; `core/` can't import `ports/`.
 *
 * Nothing here logs: the caller does.
 */
import {
  type Budget,
  BUDGET_KEY,
  budgetForDay,
  decodeBudget,
  encodeBudget,
} from '../core/token-budget.ts';
import type { StatePort } from '../ports/state-port.ts';

/**
 * Today's budget: the stored one if its day is `today`, else
 * `{day: today, inputTokens: 0}`. Writes nothing: a rollover is saved by the
 * sender only when tokens are spent. Throws `StateError` if the stored value
 * doesn't decode, and never resets it.
 */
export function loadBudget(state: StatePort, today: string): Budget {
  const raw = state.get(BUDGET_KEY);
  return budgetForDay(raw === undefined ? undefined : decodeBudget(raw), today);
}

/** Writes `state.budget`. A `StateError` from the port propagates. */
export function saveBudget(state: StatePort, budget: Budget): void {
  state.set(BUDGET_KEY, encodeBudget(budget));
}
