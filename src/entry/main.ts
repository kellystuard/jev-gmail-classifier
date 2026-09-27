/**
 * Composition root and global functions (Solution Design §4.2, §6.1).
 *
 * E2 placeholders: each function has no side effects and returns a plain,
 * JSON-serializable value. E3–E9 replace them with the real wiring. Export
 * exactly the names in `ENTRY_POINTS` and nothing else: the bundle footer is
 * generated from that list.
 */
import { loadEmbeddedConfig } from './embedded-config.ts';
import type { EntryPointName } from './entry-points.ts';

interface PlaceholderResult {
  readonly entry: EntryPointName;
  readonly status: 'placeholder';
  /**
   * How many rules the embedded config has. Loading it validates the config on
   * every execution, so the bundle proves Zod runs in Apps Script's V8.
   */
  readonly ruleCount: number;
}

function placeholder(entry: EntryPointName): PlaceholderResult {
  return { entry, status: 'placeholder', ruleCount: loadEmbeddedConfig().rules.length };
}

export function onTrigger(): PlaceholderResult {
  return placeholder('onTrigger');
}

export function install(): PlaceholderResult {
  return placeholder('install');
}

export function uninstall(): PlaceholderResult {
  return placeholder('uninstall');
}

export function startManualRun(): PlaceholderResult {
  return placeholder('startManualRun');
}

export function continueManualRun(): PlaceholderResult {
  return placeholder('continueManualRun');
}

export function cancelManualRun(): PlaceholderResult {
  return placeholder('cancelManualRun');
}
