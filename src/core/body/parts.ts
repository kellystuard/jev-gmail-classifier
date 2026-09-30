import type { GmailMessagePart } from '../gmail-types.ts';

/**
 * Tells the MIME walk whether to skip a part (Solution Design §8.3).
 *
 * Returns `true` when any of these holds:
 *
 * 1. `filename` is a non-empty string. Gmail sends `filename: ""` (empty, not
 *    absent) on every part that isn't an attachment, so `""` and `undefined`
 *    both mean "no filename".
 * 2. `body.attachmentId` is present (any string: excluding is the privacy-safe
 *    direction).
 * 3. `mimeType` is `message/rfc822`, compared case-insensitively, whether or
 *    not the part is an attachment (a forwarded message is not this message's
 *    body).
 *
 * An excluded part contributes nothing, and the walker **must never descend
 * into it**: a forwarded message's inner text parts carry inline `data` with
 * no `filename` or `attachmentId`, even when the `message/rfc822` container has
 * both. This function looks at one part only and doesn't walk `parts`.
 */
export function isExcludedPart(part: GmailMessagePart): boolean {
  if (part.filename !== undefined && part.filename !== '') {
    return true;
  }
  if (part.body?.attachmentId !== undefined) {
    return true;
  }
  return part.mimeType?.toLowerCase() === 'message/rfc822';
}
