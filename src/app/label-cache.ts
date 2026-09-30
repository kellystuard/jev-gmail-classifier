/**
 * The per-run label cache (Solution Design §6.5, epic #12 decision 4): label
 * names to IDs, loaded lazily, keyed by Gmail's comparison key. A missing
 * label is created with its missing ancestors, top-down.
 */
import { labelKey } from '../config/labels.ts';
import { UnexpectedResponseError } from '../core/errors.ts';
import { labelAncestors } from '../core/label-path.ts';
import { ok, type NoFields, type Result } from '../core/result.ts';
import type { GmailFailure, GmailPort } from '../ports/gmail-port.ts';
import type { LogPort } from '../ports/log-port.ts';

export interface LabelCache {
  /** The label's ID, creating it (and its missing ancestors) when missing. */
  idFor(name: string): Result<{ id: string; created: boolean }, GmailFailure>;
  /** Re-reads `listLabels` and replaces the cache. On failure the old cache stays. */
  refresh(): Result<NoFields, GmailFailure>;
}

export function createLabelCache(deps: {
  readonly gmail: GmailPort;
  readonly log: LogPort;
}): LabelCache {
  const { gmail, log } = deps;
  let cache: Map<string, string> | undefined;

  function load(): Result<NoFields, GmailFailure> {
    const listed = gmail.listLabels();
    if (!listed.ok) {
      return listed;
    }
    cache = new Map(listed.labels.map((label) => [labelKey(label.name), label.id]));
    return ok({});
  }

  function idFor(name: string): Result<{ id: string; created: boolean }, GmailFailure> {
    if (cache === undefined) {
      const loaded = load();
      if (!loaded.ok) {
        return loaded;
      }
    }
    const hit = cache?.get(labelKey(name));
    if (hit !== undefined) {
      return ok({ id: hit, created: false });
    }

    const path = labelAncestors(name);
    for (const ancestor of path.slice(0, -1)) {
      if (cache?.has(labelKey(ancestor)) === true) {
        continue;
      }
      const made = gmail.createLabel(ancestor);
      if (made.ok) {
        cache?.set(labelKey(made.label.name), made.label.id);
        log.info('label.created', { name: made.label.name });
      } else if (made.kind === 'scope' || made.kind === 'rate_limited') {
        return made;
      } else if (made.kind !== 'label_exists') {
        log.warn('label.parent_failed', { name: ancestor, label: name, kind: made.kind });
      }
    }

    const made = gmail.createLabel(name);
    if (made.ok) {
      cache?.set(labelKey(made.label.name), made.label.id);
      log.info('label.created', { name: made.label.name });
      return ok({ id: made.label.id, created: true });
    }
    switch (made.kind) {
      case 'scope':
      case 'rate_limited':
        return made;
      case 'label_exists': {
        const refreshed = load();
        if (!refreshed.ok) {
          return refreshed;
        }
        const found = cache?.get(labelKey(name));
        if (found === undefined) {
          throw new UnexpectedResponseError(
            `Gmail says label "${name}" exists, but it isn't in the label list`,
            { service: 'gmail', reason: 'label_exists_but_missing' },
          );
        }
        return ok({ id: found, created: false });
      }
      case 'invalid_label_name':
        throw new UnexpectedResponseError(`Gmail rejected the label name "${name}"`, {
          service: 'gmail',
          reason: 'invalid_label_name',
        });
    }
  }

  return { idFor, refresh: load };
}
