/**
 * Gmail label-name rules for the config (Solution Design §6.5, §7.2).
 *
 * Observed by E1 (`spikes/25-nested-labels.md`): Gmail compares label names
 * case-insensitively and ignores spaces around `/`, but stores them exactly as
 * typed. Instead of normalizing names, the schema rejects the forms that would
 * surprise the user.
 */

/** Gmail system labels. `labels.create` rejects them in any case (400 `Invalid label name`). */
export const RESERVED_LABEL_NAMES = [
  'Inbox',
  'Spam',
  'Trash',
  'Sent',
  'Drafts',
  'Starred',
  'Important',
  'Unread',
  'Chats',
] as const;

/** The first part of every label the classifier reserves for itself (`Jev/Error`, SD §7.1). */
const CLASSIFIER_NAMESPACE = 'Jev';

/**
 * The key Gmail compares label names by: lower case, with spaces around `/`
 * dropped. `Finance / Bill` and `finance/bill` both give `finance/bill`.
 */
export function labelKey(name: string): string {
  return name.replace(/\s*\/\s*/g, '/').toLowerCase();
}

function findReserved(part: string): string | undefined {
  const lower = part.toLowerCase();
  return RESERVED_LABEL_NAMES.find((reserved) => reserved.toLowerCase() === lower);
}

/**
 * Checks one label name against Gmail's rules. Returns the problem as a
 * message, or `undefined` when the name is fine. The message may quote the
 * name: label names are not private in the way questions are.
 */
export function labelNameProblem(name: string): string | undefined {
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part.trim() !== part)) {
    return 'each part between / must be non-empty, with no spaces at either end';
  }
  // `split` always returns at least one element.
  const first = parts[0] ?? '';
  if (first.toLowerCase() === CLASSIFIER_NAMESPACE.toLowerCase()) {
    return `labels under ${CLASSIFIER_NAMESPACE}/ are reserved for the classifier (${CLASSIFIER_NAMESPACE}/Error)`;
  }
  if (parts.length === 1) {
    if (findReserved(name) !== undefined) {
      return `"${name}" is a Gmail system label; choose another name`;
    }
    return undefined;
  }
  const reservedParent = findReserved(first);
  if (reservedParent !== undefined) {
    return `Gmail would show "${name}" as a separate label, not under the system ${reservedParent} label; choose another top-level name`;
  }
  return undefined;
}
