import type { Utf8Decoder } from '../../src/core/body/utf8.ts';

/**
 * The Node `Utf8Decoder` for tests. `new Uint8Array` wraps each signed byte to
 * 0-255. `ignoreBOM: true` keeps a leading U+FEFF as a character, and invalid
 * sequences become U+FFFD, as in Apps Script.
 */
export const nodeDecodeUtf8: Utf8Decoder = (bytes) =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(bytes));
