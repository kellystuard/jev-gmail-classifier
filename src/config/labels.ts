/**
 * Gmail label-name rules for the config (Solution Design §6.5, §7.2).
 *
 * Observed by E1 (`spikes/25-nested-labels.md`) and by #155's two label probes
 * (#329): Gmail stores a name trimmed, with each run of white space as one
 * space, and compares names by a looser key (`labelKey`). Instead of
 * normalizing names, the schema rejects the forms that would surprise the user.
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
 * The key Gmail compares label names by (#329): trimmed, each run of white
 * space (a tab included) as one space, lower case, and then a space, a `/` and
 * a `-` taken as the same character. So `Finance/Bill`, `finance-bill` and
 * `Finance Bill` share a key, `Finance /Bill` and `Finance/ Bill` share
 * another (two separators), and `Finance / Bill` (three) a third.
 *
 * Observed (second probe, `s155_labelProbe2`, cases 7a to 7d, 7g, 7h, 6b to
 * 6e, 3b, 5b, 5c: same name; 1, 2a to 2c, 3a, 4b, 5a, 5d, 6a, 7e, 7f: different
 * names). `_` and `.` stay themselves (7e, 7f).
 * NOT observed: other punctuation and non-ASCII letters. They are left out of
 * the key. If Gmail merges more than the key does, a create answers
 * `label_exists`, the lookup finds nothing, and the label cache fails loudly
 * (`label_exists_but_missing`); it never adds a label the config doesn't name.
 */
export function labelKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase().replace(/[ -]/g, '/');
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
  // Gmail takes a space, a `/` and a `-` as the same, so `Jev-Error` and
  // `Jev Error` are `Jev/Error`.
  const key = labelKey(name);
  const namespaceKey = CLASSIFIER_NAMESPACE.toLowerCase();
  if (key === namespaceKey || key.startsWith(`${namespaceKey}/`)) {
    return `Gmail treats a space, a / and a - in a label name as the same, so "${name}" falls under the classifier's ${CLASSIFIER_NAMESPACE}/ labels (${CLASSIFIER_NAMESPACE}/Error); choose another name`;
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
