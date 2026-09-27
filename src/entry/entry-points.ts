/**
 * The global functions Apps Script sees (Solution Design §6.1). The build
 * generates one top-level `function` declaration per name in the bundle footer.
 */
export const ENTRY_POINTS = [
  'onTrigger',
  'install',
  'uninstall',
  'startManualRun',
  'continueManualRun',
  'cancelManualRun',
] as const;

export type EntryPointName = (typeof ENTRY_POINTS)[number];
