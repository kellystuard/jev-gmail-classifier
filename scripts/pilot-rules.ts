/**
 * Which rules fired and which were applied, from `thread.classified` lines
 * (task #315; SD §10.5 `fired` and `actions`, SD §6.5 the move winner).
 *
 * Only rule IDs and a rule's kind leave this file as output. A label's name
 * (a config value that shows in `actions`) is used for matching, and the
 * worksheet, which stays local, may hold it.
 */
import type { Config } from '../src/config/schema.ts';
import { type PilotLine, stringArrayField, stringField } from './pilot-log.ts';

export type RuleKind = 'label' | 'move:archive' | 'move:spam' | 'move:trash' | 'move:label';

export interface RuleInfo {
  readonly id: string;
  readonly kind: RuleKind;
  /** The label a label rule adds. */
  readonly label?: string;
}

/** The config's rules in order. */
export function ruleInfos(config: Config): readonly RuleInfo[] {
  return config.rules.map((rule): RuleInfo => {
    if (rule.action === 'label') return { id: rule.id, kind: 'label', label: rule.label };
    switch (rule.destination.kind) {
      case 'archive':
        return { id: rule.id, kind: 'move:archive' };
      case 'spam':
        return { id: rule.id, kind: 'move:spam' };
      case 'trash':
        return { id: rule.id, kind: 'move:trash' };
      case 'label':
        return { id: rule.id, kind: 'move:label' };
    }
  });
}

export interface AppliedAction {
  readonly ruleId: string;
  readonly kind: RuleKind;
  /** The entry of `actions` that shows it was applied (holds a label name: local use only). */
  readonly action: string;
}

/**
 * What one `thread.classified` line applied, by rule. A label rule is applied
 * when it is in `fired` and `label:<its label>` is in `actions`. A move rule
 * is applied when it is the first move rule in `fired` (config order) and
 * `actions` holds a `move:` entry.
 */
export function appliedActions(line: PilotLine, rules: readonly RuleInfo[]): AppliedAction[] {
  const fired = new Set(stringArrayField(line.fields, 'fired') ?? []);
  const actions = stringArrayField(line.fields, 'actions') ?? [];
  const out: AppliedAction[] = [];
  let moveSeen = false;
  for (const rule of rules) {
    if (!fired.has(rule.id)) continue;
    if (rule.kind === 'label') {
      const wanted = `label:${rule.label ?? ''}`;
      if (rule.label !== undefined && actions.includes(wanted)) {
        out.push({ ruleId: rule.id, kind: rule.kind, action: wanted });
      }
    } else if (!moveSeen) {
      moveSeen = true;
      const move = actions.find((action) => action.startsWith('move:'));
      if (move !== undefined) out.push({ ruleId: rule.id, kind: rule.kind, action: move });
    }
  }
  return out;
}

/** The `thread.classified` lines' `source`, as a closed set. */
export function sourceOf(line: PilotLine): 'scheduled' | 'manual' | 'other' {
  const source = stringField(line.fields, 'source');
  return source === 'scheduled' || source === 'manual' ? source : 'other';
}

/** A model name safe to print: Jev model names look like `jev-1.13.0` or `jev-latest`. */
export function modelName(line: PilotLine): string {
  const model = stringField(line.fields, 'model');
  return model !== undefined && /^[a-z][a-z0-9.-]{0,31}$/.test(model) ? model : 'other';
}
