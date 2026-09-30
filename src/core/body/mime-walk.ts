/**
 * The MIME walk (Solution Design §8.3): chooses which parts of a message's
 * `payload` become its body, decodes them, converts HTML, and normalizes the
 * result. It's shared by every `BodyConverter`, and it never throws for any
 * tree.
 *
 * - A part `isExcludedPart` rejects (an attachment or a forwarded message)
 *   contributes nothing, and its subtree is never visited.
 * - A `text/plain` leaf gives its decoded text, and a `text/html` leaf its
 *   decoded text through `converter.htmlToText`. Any other leaf, or a leaf
 *   with no `data`, gives nothing.
 * - `multipart/alternative` gives the first child whose subtree yields
 *   `text/plain` text; if none does, the first child that yields any text.
 * - Any other part with `parts` (`multipart/mixed`, `related`, `signed`, an
 *   unknown subtype) gives the text of each child that yields text, in order,
 *   joined with a blank line.
 *
 * A part "yields text" when its result isn't empty after trimming. Only the
 * parts the walk chooses are decoded: the HTML alternative of a message with a
 * plain one is never decoded or converted, and no part is decoded twice.
 */

import type { GmailMessagePart } from '../gmail-types.ts';
import type { BodyConverter } from './body-converter.ts';
import { isExcludedPart } from './parts.ts';
import type { Utf8Decoder } from './utf8.ts';

/** What the walk needs from outside `core/`: the HTML converter and the UTF-8 decoder. */
export type BodyTextDeps = {
  readonly converter: BodyConverter;
  readonly decodeUtf8: Utf8Decoder;
};

/**
 * `plain`: only `text/plain` leaves yield text (used to find a plain
 * alternative without decoding HTML). `any`: `text/html` leaves yield too.
 */
type WalkMode = 'plain' | 'any';

/** One walk's state: its dependencies, and each leaf's text once computed. */
type Walk = {
  readonly deps: BodyTextDeps;
  readonly leafText: Map<GmailMessagePart, string>;
};

function yields(text: string): boolean {
  return text.trim() !== '';
}

function leafText(walk: Walk, part: GmailMessagePart, html: boolean): string {
  const cached = walk.leafText.get(part);
  if (cached !== undefined) {
    return cached;
  }
  const data = part.body?.data;
  let text = '';
  if (data !== undefined && data.length > 0) {
    const decoded = walk.deps.decodeUtf8(data);
    text = html ? walk.deps.converter.htmlToText(decoded) : decoded;
  }
  walk.leafText.set(part, text);
  return text;
}

function alternativeText(
  walk: Walk,
  children: readonly GmailMessagePart[],
  mode: WalkMode,
): string {
  for (const child of children) {
    const text = partText(walk, child, 'plain');
    if (yields(text)) {
      return text;
    }
  }
  if (mode === 'plain') {
    return '';
  }
  for (const child of children) {
    const text = partText(walk, child, 'any');
    if (yields(text)) {
      return text;
    }
  }
  return '';
}

function partText(walk: Walk, part: GmailMessagePart, mode: WalkMode): string {
  if (isExcludedPart(part)) {
    return '';
  }
  const mimeType = (part.mimeType ?? '').trim().toLowerCase();
  if (mimeType === 'text/plain') {
    return leafText(walk, part, false);
  }
  if (mimeType === 'text/html') {
    return mode === 'any' ? leafText(walk, part, true) : '';
  }
  const children = part.parts ?? [];
  if (mimeType === 'multipart/alternative') {
    return alternativeText(walk, children, mode);
  }
  const texts: string[] = [];
  for (const child of children) {
    const text = partText(walk, child, mode);
    if (yields(text)) {
      texts.push(text);
    }
  }
  return texts.join('\n\n');
}

/** The message's body as normalized plain text, or `''` if it has none. Never throws for any tree. */
export function messageBodyText(payload: GmailMessagePart | undefined, deps: BodyTextDeps): string {
  if (payload === undefined) {
    return '';
  }
  const walk: Walk = { deps, leafText: new Map() };
  return normalizeBodyText(partText(walk, payload, 'any'));
}

/**
 * The body's normal form: `\r\n` and `\r` become `\n`, each line loses its
 * trailing whitespace, runs of more than one blank line become one, and the
 * whole is trimmed. Idempotent, and linear in the length of `text`.
 */
export function normalizeBodyText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === '' && kept[kept.length - 1] === '') {
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').trim();
}
