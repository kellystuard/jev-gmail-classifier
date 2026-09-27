/**
 * Script Properties size limits (Solution Design §3, §7.3; ADR-0007). E3's
 * sharding and the `StatePort` fake use them. Sizes are UTF-8 bytes.
 */

/** The largest value one property may hold: 9 KB. */
export const STATE_VALUE_MAX_BYTES = 9 * 1024;

/** The largest total the store may hold: 500 KB. */
export const STATE_STORE_MAX_BYTES = 500 * 1024;

/**
 * The UTF-8 byte length of `text`, without `TextEncoder` (which Apps Script
 * lacks). A surrogate pair is 4 bytes. A lone surrogate counts as 3 bytes,
 * the size of the U+FFFD that replaces it when encoded.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  // charCodeAt past the end is NaN, which fails both comparisons.
  return unit >= 0xdc00 && unit <= 0xdfff;
}
