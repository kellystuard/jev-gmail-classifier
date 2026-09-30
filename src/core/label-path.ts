/**
 * Label-name paths (Solution Design §6.5). Pure.
 */
import { InvalidArgumentError } from './errors.ts';

/** The classifier's own label (SD §7.1). Created as `Jev`, then `Jev/Error`. */
export const JEV_ERROR_LABEL = 'Jev/Error';

/**
 * `'A/B/C'` gives `['A', 'A/B', 'A/B/C']`: the label and every ancestor,
 * top-down. Parts are trimmed, so `'A / B'` gives `['A', 'A/B']`. Throws
 * `InvalidArgumentError` for an empty name or an empty part.
 */
export function labelAncestors(name: string): readonly string[] {
  const parts = name.split('/').map((part) => part.trim());
  if (parts.some((part) => part === '')) {
    throw new InvalidArgumentError('A label name needs at least one non-empty part', {
      argument: 'name',
      reason: 'empty_part',
    });
  }
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}
