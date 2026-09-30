/**
 * A small MIME parser for the probe (Epic E5, task #102). It keeps the MIME
 * tree: each entity's own headers, its parameters, and its body bytes, so
 * `eml-thread.ts` can build the part tree Gmail would return (spike 29).
 *
 * Hand-written on purpose (see the PR for #102): the parsers checked either
 * flatten the message into text, HTML and attachments, or (mailsplit) don't
 * expand a `message/rfc822` attachment and need an untyped helper for
 * RFC 2047. This one is synchronous and has no dependency.
 *
 * It is lenient, as Gmail is: a missing closing boundary, a missing boundary
 * parameter, bad base64 or a stray line never throw. Strings that hold raw
 * bytes use `latin1`, one character per byte, so slicing never splits one.
 */
import { Buffer } from 'node:buffer';

/** One header as read: name as written, value unfolded and RFC 2047-decoded. */
export interface MimeHeader {
  readonly name: string;
  readonly value: string;
}

/** A header split into its value (lower-cased) and parameters (names lower-cased, values decoded). */
export interface StructuredHeader {
  readonly value: string;
  readonly params: ReadonlyMap<string, string>;
}

/** One MIME entity: its own headers, and its body bytes before the transfer encoding is undone. */
export interface MimeEntity {
  readonly headers: readonly MimeHeader[];
  /** The headers exactly as written (for parameters, which are parsed before RFC 2047 decoding). */
  readonly rawHeaders: readonly MimeHeader[];
  readonly body: Buffer;
}

/** A header field line: a name of printable ASCII other than `:`, then `:`. */
const HEADER_LINE = /^([!-9;-~]+)[ \t]*:(.*)$/s;

/**
 * Splits `raw` into its header block and body. The header block ends at the
 * first empty line; with none, the whole input is headers. Lines that aren't
 * header fields (and aren't continuations) are skipped.
 */
export function parseEntity(raw: Buffer): MimeEntity {
  const text = raw.toString('latin1');
  const lines: string[] = [];
  let pos = 0;
  let bodyStart = text.length;
  while (pos < text.length) {
    const lf = text.indexOf('\n', pos);
    const end = lf === -1 ? text.length : lf;
    const next = lf === -1 ? text.length : lf + 1;
    const line = text.slice(pos, end).replace(/\r$/, '');
    if (line === '') {
      bodyStart = next;
      break;
    }
    lines.push(line);
    pos = next;
  }
  const rawHeaders: MimeHeader[] = [];
  for (const line of lines) {
    const last = rawHeaders[rawHeaders.length - 1];
    if ((line.startsWith(' ') || line.startsWith('\t')) && last !== undefined) {
      // RFC 5322 §2.2.3: unfolding removes the line break only.
      rawHeaders[rawHeaders.length - 1] = { name: last.name, value: last.value + line };
      continue;
    }
    const match = HEADER_LINE.exec(line);
    if (match?.[1] !== undefined) {
      rawHeaders.push({ name: match[1], value: (match[2] ?? '').trim() });
    }
  }
  // Header bytes are latin1 here. 8-bit bytes in a header are usually UTF-8.
  const headers = rawHeaders.map(({ name, value }) => {
    const text = decodeLatin1AsText(value);
    return {
      name,
      value: ADDRESS_HEADERS.has(name.toLowerCase()) ? decodeAddressWords(text) : decodeWords(text),
    };
  });
  // latin1 maps one byte to one character, so the offset is the same in both.
  return { headers, rawHeaders, body: raw.subarray(bodyStart) };
}

/** The first header named `name` (case-insensitive), from `rawHeaders`. */
export function findHeader(headers: readonly MimeHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === lower)?.value;
}

/** Raw 8-bit header text (latin1 string) re-read as UTF-8 when valid, else windows-1252. */
function decodeLatin1AsText(value: string): string {
  // eslint-disable-next-line no-control-regex -- checking for any non-ASCII byte
  if (!/[^\x00-\x7f]/.test(value)) return value;
  return decodeCharset(Buffer.from(value, 'latin1'), undefined);
}

/**
 * Decodes `bytes` with `charset` (a WHATWG label, so `iso-8859-1`, `latin1` and
 * `us-ascii` mean windows-1252, as Gmail treats them in spike 29). With no
 * charset, or a name `TextDecoder` rejects: UTF-8 if the bytes are valid
 * UTF-8, else windows-1252 (spike 29, scenarios 8b and 9b).
 */
export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = charset?.trim();
  if (label !== undefined && label !== '') {
    try {
      return new TextDecoder(label, { ignoreBOM: true }).decode(bytes);
    } catch {
      // An unknown label: fall through to the guess below.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252', { ignoreBOM: true }).decode(bytes);
  }
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/**
 * Decodes RFC 2047 encoded-words. Whitespace between two adjacent
 * encoded-words is dropped (RFC 2047 §6.2). A word that can't be decoded is
 * left as written.
 */
export function decodeWords(value: string): string {
  if (!value.includes('=?')) return value;
  const joined = value.replace(/(\?=)[ \t]+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, '$1');
  return joined.replace(ENCODED_WORD, (word, charset: string, encoding: string, text: string) => {
    const bytes =
      encoding.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : decodeQuotedPrintable(Buffer.from(text.replace(/_/g, ' '), 'latin1'));
    // RFC 2231 §5: a charset may carry `*<language>`.
    const name = charset.split('*')[0] ?? charset;
    try {
      return new TextDecoder(name, { ignoreBOM: true }).decode(bytes);
    } catch {
      return word;
    }
  });
}

/** Headers whose value is an address list (RFC 5322 §3.6.2, §3.6.3). */
const ADDRESS_HEADERS = new Set([
  'from',
  'sender',
  'reply-to',
  'to',
  'cc',
  'bcc',
  'resent-from',
  'resent-sender',
  'resent-to',
  'resent-cc',
  'resent-bcc',
]);

/** A run of encoded-words, with only whitespace between them. */
const ENCODED_RUN = /=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=(?:[ \t]+=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)*/g;

/**
 * Like `decodeWords`, for an address header: Gmail puts a decoded display
 * name in double quotes (`"José Müller" <jose@example.com>`, spike 29
 * scenario 10), so the decoded text can't be misread as address syntax.
 */
export function decodeAddressWords(value: string): string {
  return value.replace(ENCODED_RUN, (run: string, offset: number) => {
    const decoded = decodeWords(run);
    // Already inside a quoted string (common, though RFC 2047 forbids it).
    const quotesBefore = (value.slice(0, offset).match(/(?<!\\)"/g) ?? []).length;
    if (decoded === run || quotesBefore % 2 === 1) return decoded;
    return `"${decoded.replace(/(["\\])/g, '\\$1')}"`;
  });
}

/** Splits `s` on `;` outside quoted strings. */
function splitParams(s: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (quoted && c === '\\' && i + 1 < s.length) {
      current += c + s.charAt(i + 1);
      i++;
    } else if (c === '"') {
      quoted = !quoted;
      current += c;
    } else if (c === ';' && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return t;
}

/** Decodes an RFC 2231 extended value: `charset'language'percent-encoded`. */
function decodeExtended(value: string, withCharset: boolean): { charset?: string; bytes: Buffer } {
  let charset: string | undefined;
  let text = value;
  if (withCharset) {
    const parts = value.split("'");
    if (parts.length >= 3) {
      charset = parts[0];
      text = parts.slice(2).join("'");
    }
  }
  const bytes = Buffer.from(
    text.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    'latin1',
  );
  return charset === undefined || charset === '' ? { bytes } : { charset, bytes };
}

/**
 * Parses a structured header such as `Content-Type` or `Content-Disposition`
 * as written (not yet RFC 2047-decoded). Parameters use RFC 2231 (`name*`,
 * `name*0`, `name*0*`) and, as many mailers send, RFC 2047 inside a value.
 */
export function parseStructured(raw: string | undefined): StructuredHeader {
  if (raw === undefined) return { value: '', params: new Map() };
  const [head = '', ...rest] = splitParams(raw);
  const plain = new Map<string, string>();
  const sections = new Map<string, { index: number; extended: boolean; text: string }[]>();
  for (const param of rest) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    const text = unquote(param.slice(eq + 1));
    const section = /^(.+?)\*(\d+)?(\*)?$/.exec(key);
    if (section?.[1] !== undefined) {
      const list = sections.get(section[1]) ?? [];
      list.push({
        index: section[2] === undefined ? 0 : Number(section[2]),
        // `name*` (no index) is extended; `name*0*` is; `name*0` isn't.
        extended: section[2] === undefined || section[3] !== undefined,
        text,
      });
      sections.set(section[1], list);
    } else if (!plain.has(key)) {
      plain.set(key, text);
    }
  }
  const params = new Map<string, string>();
  for (const [key, text] of plain) {
    params.set(key, decodeWords(decodeLatin1AsText(text)));
  }
  for (const [key, list] of sections) {
    list.sort((a, b) => a.index - b.index);
    let charset: string | undefined;
    const chunks: Buffer[] = [];
    for (const [i, item] of list.entries()) {
      if (item.extended) {
        const decoded = decodeExtended(item.text, i === 0);
        if (i === 0) charset = decoded.charset;
        chunks.push(decoded.bytes);
      } else {
        chunks.push(Buffer.from(item.text, 'latin1'));
      }
    }
    // An RFC 2231 value wins over a plain one of the same name.
    params.set(key, decodeCharset(Buffer.concat(chunks), charset));
  }
  return { value: head.trim().toLowerCase(), params };
}

/** Undoes quoted-printable leniently: soft breaks removed, `=XX` decoded, a stray `=` kept. */
export function decodeQuotedPrintable(bytes: Buffer): Buffer {
  const text = bytes
    .toString('latin1')
    .replace(/[ \t]+(?=\r?\n)/g, '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(text, 'latin1');
}

/** Undoes a `Content-Transfer-Encoding`. `7bit`, `8bit`, `binary` and unknown names pass through. */
export function decodeTransfer(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'base64':
      // Node skips characters outside the alphabet and stops at bad padding.
      return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    case 'quoted-printable':
      return decodeQuotedPrintable(body);
    default:
      return body;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The body parts of a multipart body, between its delimiter lines. The line
 * break before a delimiter belongs to the delimiter (RFC 2046 §5.1.1). The
 * preamble and epilogue are dropped. Without a closing delimiter, the last
 * part runs to the end.
 */
export function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString('latin1');
  const delimiter = new RegExp(
    `(^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*(\\r?\\n|$)`,
    'g',
  );
  const parts: Buffer[] = [];
  let start: number | undefined;
  for (let match = delimiter.exec(text); match !== null; match = delimiter.exec(text)) {
    if (start !== undefined) {
      parts.push(Buffer.from(text.slice(start, match.index), 'latin1'));
    }
    if (match[2] === '--') {
      start = undefined;
      break;
    }
    start = match.index + match[0].length;
    // The line break that ended this delimiter can start the next one.
    if (match[3] !== '' && match[3] !== undefined) delimiter.lastIndex -= match[3].length;
  }
  if (start !== undefined) parts.push(Buffer.from(text.slice(start), 'latin1'));
  return parts;
}
