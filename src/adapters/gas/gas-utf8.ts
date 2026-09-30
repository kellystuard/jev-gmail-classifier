import type { Utf8Decoder } from '../../core/body/utf8.ts';

/**
 * There is no Apps Script type package (epic decision 15), and `declare const`
 * emits nothing: the global is Apps Script's.
 */
declare const Utilities: {
  newBlob(data: readonly number[]): { getDataAsString(charset: string): string };
};

/**
 * Decodes a part's `body.data` as UTF-8. Gmail has already transcoded every
 * text part to UTF-8, so the declared charset is never used (spike 29).
 */
export const gasDecodeUtf8: Utf8Decoder = (bytes) =>
  Utilities.newBlob(bytes).getDataAsString('UTF-8');
