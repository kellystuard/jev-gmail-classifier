/**
 * Turns a saved `.eml` file into the `GmailThread` the Advanced Gmail Service
 * would return for it (spike 29, `test/fixtures/gmail/`), so the probe runs
 * the same `threadToState` as the deployed script (Epic E5, task #102).
 *
 * What Gmail does, and this copies:
 * - The part tree mirrors the MIME tree, numbered `""`, then `"0"`, `"1"`,
 *   then `"0.0"`, …; a `message/rfc822` part is expanded into one child, the
 *   inner message's root (`"1"` → `"1.0"` → `"1.0.0"`).
 * - Each part carries its own headers, unfolded and RFC 2047-decoded.
 * - A text part's `data` is the text re-encoded as UTF-8, in signed bytes,
 *   whatever charset it declared. Attachments, and any part that isn't
 *   `text/*`, get an `attachmentId` and no `data`.
 */
import { Buffer } from 'node:buffer';

import type { Utf8Decoder } from '../src/core/body/utf8.ts';
import type {
  GmailMessagePart,
  GmailMessagePartBody,
  GmailThread,
} from '../src/core/gmail-types.ts';
import {
  decodeCharset,
  decodeTransfer,
  findHeader,
  parseEntity,
  parseStructured,
  splitMultipart,
} from './mime.ts';

/** The file isn't an email: it has no header at all. */
export class EmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmlParseError';
  }
}

/**
 * The Node `Utf8Decoder` the probe passes to `threadToState`, the same as
 * `test/fakes/node-utf8.ts` (copied: `scripts/` doesn't depend on `test/`).
 */
export const nodeDecodeUtf8: Utf8Decoder = (bytes) =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(bytes));

/** Deeper nesting than this is treated as a leaf, so a hostile file can't recurse forever. */
const MAX_DEPTH = 32;

function childId(parentId: string, index: number): string {
  return parentId === '' ? String(index) : `${parentId}.${String(index)}`;
}

function toSigned(bytes: Uint8Array): number[] {
  return Array.from(bytes, (b) => (b > 127 ? b - 256 : b));
}

function buildPart(raw: Buffer, partId: string, depth: number): GmailMessagePart {
  const entity = parseEntity(raw);
  const contentType = parseStructured(findHeader(entity.rawHeaders, 'Content-Type'));
  const disposition = parseStructured(findHeader(entity.rawHeaders, 'Content-Disposition'));
  const mimeType = contentType.value.includes('/') ? contentType.value : 'text/plain';
  const filename = disposition.params.get('filename') ?? contentType.params.get('name') ?? '';
  const encoding = findHeader(entity.rawHeaders, 'Content-Transfer-Encoding');
  const base = { partId, mimeType, filename, headers: entity.headers };
  const nested = depth < MAX_DEPTH;

  const boundary = contentType.params.get('boundary');
  if (mimeType.startsWith('multipart/') && boundary !== undefined && boundary !== '' && nested) {
    const parts = splitMultipart(entity.body, boundary).map((child, i) =>
      buildPart(child, childId(partId, i), depth + 1),
    );
    return { ...base, body: { size: 0 }, parts };
  }

  const bytes = decodeTransfer(entity.body, encoding);
  if (mimeType === 'message/rfc822' && nested) {
    // Gmail gives a named (attached) message an attachmentId and its raw size,
    // and still expands it (fixture 14). An inline one has neither (14b).
    const body: GmailMessagePartBody =
      filename === '' ? { size: 0 } : { size: bytes.length, attachmentId: `eml-${partId}` };
    return { ...base, body, parts: [buildPart(bytes, childId(partId, 0), depth + 1)] };
  }
  if (filename !== '' || !mimeType.startsWith('text/')) {
    return { ...base, body: { size: bytes.length, attachmentId: `eml-${partId}` } };
  }
  const text = decodeCharset(bytes, contentType.params.get('charset'));
  return {
    ...base,
    body: { size: bytes.length, data: toSigned(Buffer.from(text, 'utf8')) },
  };
}

/**
 * One `.eml` as a one-message thread. `id` (the file's base name) is the
 * thread's and the message's ID. `internalDate` comes from the `Date` header
 * when it parses.
 *
 * @throws EmlParseError when the file has no header at all.
 */
export function emlToThread(raw: Uint8Array, id: string): GmailThread {
  const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const payload = buildPart(buffer, '', 0);
  if (payload.headers === undefined || payload.headers.length === 0) {
    throw new EmlParseError('no email headers found');
  }
  const date = Date.parse(findHeader(payload.headers, 'Date') ?? '');
  const internalDate = Number.isNaN(date) ? {} : { internalDate: String(date) };
  return {
    id,
    messages: [{ id, threadId: id, labelIds: [], ...internalDate, payload }],
  };
}
