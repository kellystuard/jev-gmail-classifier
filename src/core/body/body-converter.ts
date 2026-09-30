/**
 * The HTML-to-text converters behind `plainTextMethod` (Solution Design §8.3,
 * ADR-0011). A converter only turns an HTML string into text: the MIME walk
 * that picks which part to convert is shared by every converter
 * (`mime-walk.ts`), and calls `htmlToText` on a decoded `text/html` part.
 */

import { assertNever } from '../assert-never.ts';
import { basicConverter } from './basic.ts';

/**
 * The values of `plainTextMethod` core knows. Declared here rather than taken
 * from `config/`, so the body modules don't depend on the config schema (the
 * probe and the tests pass plain values). A type-level test checks that
 * `Config['plainTextMethod']` is assignable to it.
 */
export type PlainTextMethod = 'basic';

/** Turns HTML into the plain text that goes into a message's `body`. */
export interface BodyConverter {
  readonly method: PlainTextMethod;
  /** Turns an HTML document or fragment into plain text. Never throws, for any input. */
  htmlToText(html: string): string;
}

/** The converter for a `plainTextMethod` value. */
export function selectBodyConverter(method: PlainTextMethod): BodyConverter {
  switch (method) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- one value today; the exhaustive switch makes a new method a type error until it is handled.
    case 'basic':
      return basicConverter;
    default:
      return assertNever(method);
  }
}
