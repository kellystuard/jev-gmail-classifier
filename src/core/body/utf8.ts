/** Decodes a part's `body.data` (signed bytes, already UTF-8, spike 29) to text. Injected: core can't decode bytes. */
export type Utf8Decoder = (bytes: readonly number[]) => string;
