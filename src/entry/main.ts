/**
 * Composition root and global functions (Solution Design §4.2, §6.1).
 *
 * E2 placeholders: each function has no side effects and returns a plain,
 * JSON-serializable value. E3–E9 replace them with the real wiring. Export
 * exactly the names in `ENTRY_POINTS` and nothing else: the bundle footer is
 * generated from that list.
 */
import { embeddedConfig } from './embedded-config.ts';
import type { EntryPointName } from './entry-points.ts';

interface PlaceholderResult {
  readonly entry: EntryPointName;
  readonly status: 'placeholder';
  /** Whether the build embedded a config. Reading it keeps it in the bundle. */
  readonly configEmbedded: boolean;
}

function placeholder(entry: EntryPointName): PlaceholderResult {
  return { entry, status: 'placeholder', configEmbedded: embeddedConfig() !== undefined };
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
