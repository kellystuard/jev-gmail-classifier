/**
 * The event catalog: every event the script logs, with the levels it may be
 * logged at (Solution Design §10.5, Engineering Standards §6; epic #15
 * decision 5, story #141 decision S4).
 *
 * `LogPort` takes any string as the event name, so nothing in `src/` has to
 * import this file. Tests keep it true: one scans `src/` for log calls and
 * compares their names and levels with the catalog, and another compares the
 * catalog with the "Main events" list in SD §10.5. Adding an event means
 * adding it here and in that list. Pure: no imports.
 */

export type LogEventLevel = 'info' | 'warn' | 'error';

/** Every event the script logs, with the levels it may be logged at (SD §10.5). In the SD list's order. */
export const LOG_EVENT_LEVELS = {
  'run.start': ['info'],
  'run.skipped': ['info'],
  'run.end': ['info', 'warn'],
  'run.failed': ['error'],
  'run.unfinished': ['warn'],
  'ingest.done': ['info', 'warn'],
  'history.expired': ['warn'],
  'history.fallback_missed': ['warn'],
  'thread.classified': ['info', 'warn'],
  'thread.excluded': ['info', 'warn'],
  'thread.skipped': ['info'],
  'thread.failed': ['warn'],
  'thread.errored': ['warn'],
  'jev.batch': ['info'],
  'jev.outage': ['warn'],
  scope_missing: ['warn'],
  'budget.reached': ['warn'],
  'alert.sent': ['info'],
  'alert.failed': ['warn'],
  'label.created': ['info'],
  'label.parent_failed': ['warn'],
  'manual.started': ['info'],
  'manual.rejected': ['warn'],
  'manual.progress': ['info'],
  'manual.completed': ['info'],
  'manual.cancelled': ['info'],
  'manual.cursor_reset': ['warn'],
} as const satisfies Readonly<Record<string, readonly LogEventLevel[]>>;

export type LogEventName = keyof typeof LOG_EVENT_LEVELS;

/** True when `name` is an event in the catalog. */
export function isLogEventName(name: string): name is LogEventName {
  return Object.prototype.hasOwnProperty.call(LOG_EVENT_LEVELS, name);
}

/** Every event name in the code, in the catalog's order. */
export const LOG_EVENTS: readonly LogEventName[] =
  Object.keys(LOG_EVENT_LEVELS).filter(isLogEventName);
