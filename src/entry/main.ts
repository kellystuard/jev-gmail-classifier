/**
 * Composition root and global functions (Solution Design §4.2, §6.1).
 *
 * E2 placeholders: each function has no side effects and returns a plain,
 * JSON-serializable value. E3–E9 replace them with the real wiring. Export
 * exactly the names in `ENTRY_POINTS` and nothing else: the bundle footer is
 * generated from that list.
 */
import type { EntryPointName } from './entry-points.ts';

interface PlaceholderResult {
  readonly entry: EntryPointName;
  readonly status: 'placeholder';
}

export function onTrigger(): PlaceholderResult {
  return { entry: 'onTrigger', status: 'placeholder' };
}

export function install(): PlaceholderResult {
  return { entry: 'install', status: 'placeholder' };
}

export function uninstall(): PlaceholderResult {
  return { entry: 'uninstall', status: 'placeholder' };
}

export function startManualRun(): PlaceholderResult {
  return { entry: 'startManualRun', status: 'placeholder' };
}

export function continueManualRun(): PlaceholderResult {
  return { entry: 'continueManualRun', status: 'placeholder' };
}

export function cancelManualRun(): PlaceholderResult {
  return { entry: 'cancelManualRun', status: 'placeholder' };
}
