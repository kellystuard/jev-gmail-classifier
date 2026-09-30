/**
 * The in-house `basic` HTML-to-text converter (Solution Design §8.3,
 * ADR-0011). It has no dependencies and makes one hand-written index scan over
 * the input, so it runs in linear time for any input, hostile or not, and it
 * never throws.
 *
 * What it does, in short:
 *
 * - Drops comments (Outlook conditional comments included), declarations,
 *   processing instructions, and the contents of `<head>`, `<style>`,
 *   `<script>`, `<noscript>` and `<template>`. Anything left unclosed at the
 *   end of the input drops the rest, so nothing hidden leaks into `state`.
 * - Turns `<br>` and block tags into line breaks, starts a `<li>` with `- `,
 *   and ends a table cell with a space. Every other tag is removed and its
 *   text kept; images and their `alt` text are dropped.
 * - Decodes numeric references and the named ones in `NAMED_ENTITIES`, once.
 * - Removes invisible padding characters, turns non-breaking spaces into
 *   spaces, collapses whitespace, and trims each line.
 *
 * The output is already in the MIME walk's normal form: no `\r`, no trailing
 * whitespace on a line, at most one blank line in a row, and trimmed.
 */

import type { BodyConverter } from './body-converter.ts';

/**
 * The named character references `basic` decodes, matched case-sensitively and
 * only with a closing `;`. Any other name stays as written. The list:
 *
 * - HTML 4's Latin-1 set, `nbsp` to `yuml` (U+00A0 to U+00FF), in code point
 *   order.
 * - The markup characters `amp`, `lt`, `gt`, `quot` and `apos`.
 * - The punctuation, symbols and spaces marketing mail uses.
 * - `fnof`, `circ`, `tilde`, `OElig`, `oelig`, `Scaron`, `scaron` and `Yuml`,
 *   so every windows-1252 character has its HTML 4 name as well as its
 *   numeric form (numeric references 128 to 159 map to windows-1252 too).
 *
 * One plain object literal, read with `hasOwnProperty`, so a name such as
 * `constructor` is never found on the prototype.
 */
export const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  // HTML 4 Latin-1, U+00A0 to U+00FF.
  nbsp: '\u00A0',
  iexcl: '¡',
  cent: '¢',
  pound: '£',
  curren: '¤',
  yen: '¥',
  brvbar: '¦',
  sect: '§',
  uml: '¨',
  copy: '©',
  ordf: 'ª',
  laquo: '«',
  not: '¬',
  shy: '\u00AD',
  reg: '®',
  macr: '¯',
  deg: '°',
  plusmn: '±',
  sup2: '²',
  sup3: '³',
  acute: '´',
  micro: 'µ',
  para: '¶',
  middot: '·',
  cedil: '¸',
  sup1: '¹',
  ordm: 'º',
  raquo: '»',
  frac14: '¼',
  frac12: '½',
  frac34: '¾',
  iquest: '¿',
  Agrave: 'À',
  Aacute: 'Á',
  Acirc: 'Â',
  Atilde: 'Ã',
  Auml: 'Ä',
  Aring: 'Å',
  AElig: 'Æ',
  Ccedil: 'Ç',
  Egrave: 'È',
  Eacute: 'É',
  Ecirc: 'Ê',
  Euml: 'Ë',
  Igrave: 'Ì',
  Iacute: 'Í',
  Icirc: 'Î',
  Iuml: 'Ï',
  ETH: 'Ð',
  Ntilde: 'Ñ',
  Ograve: 'Ò',
  Oacute: 'Ó',
  Ocirc: 'Ô',
  Otilde: 'Õ',
  Ouml: 'Ö',
  times: '×',
  Oslash: 'Ø',
  Ugrave: 'Ù',
  Uacute: 'Ú',
  Ucirc: 'Û',
  Uuml: 'Ü',
  Yacute: 'Ý',
  THORN: 'Þ',
  szlig: 'ß',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  atilde: 'ã',
  auml: 'ä',
  aring: 'å',
  aelig: 'æ',
  ccedil: 'ç',
  egrave: 'è',
  eacute: 'é',
  ecirc: 'ê',
  euml: 'ë',
  igrave: 'ì',
  iacute: 'í',
  icirc: 'î',
  iuml: 'ï',
  eth: 'ð',
  ntilde: 'ñ',
  ograve: 'ò',
  oacute: 'ó',
  ocirc: 'ô',
  otilde: 'õ',
  ouml: 'ö',
  divide: '÷',
  oslash: 'ø',
  ugrave: 'ù',
  uacute: 'ú',
  ucirc: 'û',
  uuml: 'ü',
  yacute: 'ý',
  thorn: 'þ',
  yuml: 'ÿ',
  // Markup characters.
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Punctuation, symbols and spaces.
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  lsaquo: '‹',
  rsaquo: '›',
  bull: '•',
  euro: '€',
  dagger: '†',
  Dagger: '‡',
  permil: '‰',
  prime: '′',
  Prime: '″',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200C',
  zwj: '\u200D',
  lrm: '\u200E',
  rlm: '\u200F',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  // The rest of windows-1252.
  fnof: 'ƒ',
  circ: 'ˆ',
  tilde: '˜',
  OElig: 'Œ',
  oelig: 'œ',
  Scaron: 'Š',
  scaron: 'š',
  Yuml: 'Ÿ',
};

/**
 * What numeric references 128 to 159 (0x80 to 0x9F) decode to, as in the HTML
 * standard: the windows-1252 character, or the C1 control itself for the five
 * code points windows-1252 leaves undefined (0x81, 0x8D, 0x8F, 0x90, 0x9D).
 * Indexed by code point minus 0x80.
 */
const WINDOWS_1252_C1 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F' + '\u0090‘’“”•–—˜™š›œ\u009DžŸ';

/**
 * Invisible characters removed after entity decoding, since marketing mail
 * pads its hidden preheader with them: U+00AD (soft hyphen), U+034F
 * (combining grapheme joiner), U+180E (Mongolian vowel separator), U+200B to
 * U+200D (zero-width space, non-joiner, joiner), U+2060 to U+2064 (word
 * joiner and the invisible operators), and U+FEFF (zero-width no-break space).
 * U+034F sits outside the class, since lint rejects a combining mark inside one.
 */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200D\u2060-\u2064\uFEFF]|\u034F/g;

/** Non-breaking spaces (U+00A0, U+2007 figure space, U+202F narrow), which become spaces. */
const NON_BREAKING_SPACE = /[\u00A0\u2007\u202F]/g;

/** HTML whitespace: one run becomes one space. HTML source newlines aren't line breaks. */
const HTML_WHITESPACE_RUN = /[ \t\n\f\r]+/g;

/** Block tags that end the current line, opening or closing. */
const LINE_BLOCKS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'caption',
  'center',
  'dd',
  'details',
  'div',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'li',
  'main',
  'nav',
  'section',
  'summary',
  'tbody',
  'tfoot',
  'thead',
  'tr',
]);

/** Block tags that leave one blank line before and after, opening or closing. */
const PARAGRAPH_BLOCKS: ReadonlySet<string> = new Set([
  'blockquote',
  'dl',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'ol',
  'p',
  'pre',
  'table',
  'ul',
]);

/**
 * Elements whose whole content is dropped, up to their closing tag. `head`
 * also ends at a `<body` tag.
 */
const DROPPED_CONTENT: ReadonlySet<string> = new Set([
  'head',
  'noscript',
  'script',
  'style',
  'template',
]);

/** The longest named reference looked for after an `&`, which bounds the lookahead. */
const MAX_ENTITY_NAME_LENGTH = 32;

const TAB = 0x09;
const LF = 0x0a;
const FF = 0x0c;
const CR = 0x0d;
const SPACE = 0x20;
const BANG = 0x21;
const DOUBLE_QUOTE = 0x22;
const HASH = 0x23;
const AMPERSAND = 0x26;
const SINGLE_QUOTE = 0x27;
const SLASH = 0x2f;
const SEMICOLON = 0x3b;
const LESS_THAN = 0x3c;
const EQUALS = 0x3d;
const GREATER_THAN = 0x3e;
const QUESTION = 0x3f;

function isHtmlSpace(code: number): boolean {
  return code === SPACE || code === TAB || code === LF || code === FF || code === CR;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function lowerAscii(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

/** The value of a digit in base 10 or 16, or -1. */
function digitValue(code: number, hex: boolean): number {
  if (isAsciiDigit(code)) {
    return code - 0x30;
  }
  if (!hex) {
    return -1;
  }
  const lower = lowerAscii(code);
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
}

/** Whether `code` ends a tag name: whitespace, `/`, `>`, or the end of input (`NaN`). */
function endsTagName(code: number): boolean {
  return Number.isNaN(code) || isHtmlSpace(code) || code === SLASH || code === GREATER_THAN;
}

/** Where the tag name that starts at `start` ends. */
function tagNameEnd(html: string, start: number): number {
  let i = start;
  while (i < html.length && !endsTagName(html.charCodeAt(i))) {
    i++;
  }
  return i;
}

/**
 * Whether the ASCII lower-case `name` is at `pos`, in any letter case, and
 * followed by the end of a tag name.
 */
function nameAt(html: string, pos: number, name: string): boolean {
  if (pos + name.length > html.length) {
    return false;
  }
  for (let k = 0; k < name.length; k++) {
    if (lowerAscii(html.charCodeAt(pos + k)) !== name.charCodeAt(k)) {
      return false;
    }
  }
  return endsTagName(html.charCodeAt(pos + name.length));
}

/**
 * The index just after the `>` that ends a tag whose attributes start at
 * `pos`, or -1 when the input ends first. A quoted attribute value (after `=`)
 * is skipped whole, so a `>` inside it doesn't end the tag.
 */
function tagEnd(html: string, pos: number): number {
  let i = pos;
  while (i < html.length) {
    const code = html.charCodeAt(i);
    if (code === GREATER_THAN) {
      return i + 1;
    }
    if (code !== EQUALS) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < html.length && isHtmlSpace(html.charCodeAt(j))) {
      j++;
    }
    const quote = html.charCodeAt(j);
    if (quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE) {
      const close = html.indexOf(quote === DOUBLE_QUOTE ? '"' : "'", j + 1);
      if (close === -1) {
        return -1;
      }
      i = close + 1;
    } else {
      i = j;
    }
  }
  return -1;
}

/**
 * Where the content of a dropped element that starts at `from` ends: the `<`
 * of its closing tag (or, for `head`, of a `<body` tag), or -1 when there is
 * none. Each `<` is looked at once, so the search is linear.
 */
function droppedContentEnd(html: string, from: number, name: string): number {
  let pos = from;
  for (;;) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) {
      return -1;
    }
    if (html.charCodeAt(lt + 1) === SLASH && nameAt(html, lt + 2, name)) {
      return lt;
    }
    if (name === 'head' && nameAt(html, lt + 1, 'body')) {
      return lt;
    }
    pos = lt + 1;
  }
}

/** The text of a numeric reference's code point (HTML standard rules). */
function codePointText(value: number): string {
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return '�';
  }
  if (value >= 0x80 && value <= 0x9f) {
    return WINDOWS_1252_C1.charAt(value - 0x80);
  }
  return String.fromCodePoint(value);
}

/** A decoded character reference and the index just after it. */
interface DecodedEntity {
  readonly text: string;
  readonly end: number;
}

/**
 * The character reference at `amp` (an `&`), or `undefined` when there is no
 * complete one there, in which case the `&` is literal text.
 */
function entityAt(html: string, amp: number): DecodedEntity | undefined {
  if (html.charCodeAt(amp + 1) === HASH) {
    let j = amp + 2;
    const marker = html.charCodeAt(j);
    const hex = marker === 0x78 || marker === 0x58;
    if (hex) {
      j++;
    }
    const digitsStart = j;
    let value = 0;
    while (j < html.length) {
      const digit = digitValue(html.charCodeAt(j), hex);
      if (digit < 0) {
        break;
      }
      // Once past U+10FFFF the value only has to stay invalid, and stays a safe integer.
      if (value <= 0x10ffff) {
        value = value * (hex ? 16 : 10) + digit;
      }
      j++;
    }
    if (j === digitsStart || html.charCodeAt(j) !== SEMICOLON) {
      return undefined;
    }
    return { text: codePointText(value), end: j + 1 };
  }
  const nameStart = amp + 1;
  const limit = Math.min(html.length, nameStart + MAX_ENTITY_NAME_LENGTH);
  let j = nameStart;
  while (j < limit) {
    const code = html.charCodeAt(j);
    if (!isAsciiLetter(code) && !isAsciiDigit(code)) {
      break;
    }
    j++;
  }
  if (j === nameStart || html.charCodeAt(j) !== SEMICOLON) {
    return undefined;
  }
  const name = html.slice(nameStart, j);
  if (!Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)) {
    return undefined;
  }
  const text = NAMED_ENTITIES[name];
  return text === undefined ? undefined : { text, end: j + 1 };
}

/** One line's text in final form: no invisible characters, whitespace collapsed, trimmed. */
function finishLine(pieces: readonly string[]): string {
  return pieces
    .join('')
    .replace(INVISIBLE, '')
    .replace(NON_BREAKING_SPACE, ' ')
    .replace(HTML_WHITESPACE_RUN, ' ')
    .trim();
}

/** The output being built: finished lines, and the pieces of the current one. */
class TextBuilder {
  private readonly lines: string[] = [];
  private pieces: string[] = [];
  private bullet = false;

  text(piece: string): void {
    this.pieces.push(piece);
  }

  /** `<br>`: ends the current line, even an empty one. */
  lineBreak(): void {
    this.finish(true);
  }

  /** A block tag: ends the current line if it has text. */
  endLine(): void {
    this.finish(false);
  }

  /** A paragraph-like block tag: ends the current line and leaves one blank line. */
  blankLine(): void {
    this.finish(false);
    this.push('');
  }

  /** `<li>`: the next line with text starts with `- `. */
  startItem(): void {
    this.finish(false);
    this.bullet = true;
  }

  /** `</li>`: an item with no text leaves nothing. */
  endItem(): void {
    this.finish(false);
    this.bullet = false;
  }

  result(): string {
    this.finish(false);
    if (this.lines[this.lines.length - 1] === '') {
      this.lines.pop();
    }
    return this.lines.join('\n');
  }

  private finish(keepEmpty: boolean): void {
    const line = finishLine(this.pieces);
    this.pieces = [];
    if (line !== '') {
      this.push(this.bullet ? `- ${line}` : line);
      this.bullet = false;
    } else if (keepEmpty) {
      this.push('');
    }
  }

  /** Adds a line, never starting with a blank one or leaving two blank ones in a row. */
  private push(line: string): void {
    if (line === '' && (this.lines.length === 0 || this.lines[this.lines.length - 1] === '')) {
      return;
    }
    this.lines.push(line);
  }
}

function openTag(out: TextBuilder, name: string): void {
  if (name === 'br') {
    out.lineBreak();
  } else if (name === 'li') {
    out.startItem();
  } else if (name === 'td' || name === 'th') {
    out.text(' ');
  } else if (PARAGRAPH_BLOCKS.has(name)) {
    out.blankLine();
  } else if (LINE_BLOCKS.has(name)) {
    out.endLine();
  }
}

function closeTag(out: TextBuilder, name: string): void {
  if (name === 'br') {
    // Browsers treat `</br>` as `<br>`.
    out.lineBreak();
  } else if (name === 'li') {
    out.endItem();
  } else if (name === 'td' || name === 'th') {
    out.text(' ');
  } else if (PARAGRAPH_BLOCKS.has(name)) {
    out.blankLine();
  } else if (LINE_BLOCKS.has(name)) {
    out.endLine();
  }
}

/** Where markup that ends with `terminator`, searched from `from`, ends; the end of input if never. */
function skipPast(html: string, from: number, terminator: string): number {
  const at = html.indexOf(terminator, from);
  return at === -1 ? html.length : at + terminator.length;
}

/**
 * Handles the markup at `lt` (a `<`) and returns the index to continue from,
 * or -1 when the `<` is literal text. Returning `html.length` drops the rest
 * of the input (an unclosed tag, comment or dropped element).
 */
function markupAt(html: string, lt: number, out: TextBuilder): number {
  const next = html.charCodeAt(lt + 1);
  if (next === BANG) {
    if (html.startsWith('<!--', lt)) {
      // From lt + 2, so `<!-->` and `<!--->` end at once, as in browsers.
      return skipPast(html, lt + 2, '-->');
    }
    if (html.startsWith('<![CDATA[', lt)) {
      return skipPast(html, lt + 9, ']]>');
    }
    return skipPast(html, lt + 2, '>');
  }
  if (next === QUESTION) {
    return skipPast(html, lt + 2, '>');
  }
  if (next === SLASH) {
    if (!isAsciiLetter(html.charCodeAt(lt + 2))) {
      return skipPast(html, lt + 2, '>');
    }
    const nameEnd = tagNameEnd(html, lt + 2);
    const end = tagEnd(html, nameEnd);
    if (end === -1) {
      return html.length;
    }
    closeTag(out, html.slice(lt + 2, nameEnd).toLowerCase());
    return end;
  }
  if (!isAsciiLetter(next)) {
    return -1;
  }
  const nameEnd = tagNameEnd(html, lt + 1);
  const end = tagEnd(html, nameEnd);
  if (end === -1) {
    return html.length;
  }
  const name = html.slice(lt + 1, nameEnd).toLowerCase();
  if (DROPPED_CONTENT.has(name)) {
    const contentEnd = droppedContentEnd(html, end, name);
    return contentEnd === -1 ? html.length : contentEnd;
  }
  openTag(out, name);
  return end;
}

/** Converts HTML to plain text with the `basic` rules. Never throws, and runs in linear time. */
export function basicHtmlToText(html: string): string {
  const out = new TextBuilder();
  // The text in html[textStart, i) is not yet in `out`.
  let textStart = 0;
  let i = 0;
  while (i < html.length) {
    const code = html.charCodeAt(i);
    if (code === LESS_THAN) {
      // The text before a tag goes in first, since the tag may end its line.
      out.text(html.slice(textStart, i));
      textStart = i;
      const next = markupAt(html, i, out);
      if (next !== -1) {
        i = next;
        textStart = next;
        continue;
      }
    } else if (code === AMPERSAND) {
      const entity = entityAt(html, i);
      if (entity !== undefined) {
        out.text(html.slice(textStart, i));
        out.text(entity.text);
        i = entity.end;
        textStart = i;
        continue;
      }
    }
    i++;
  }
  out.text(html.slice(textStart));
  return out.result();
}

/** The `basic` converter. */
export const basicConverter: BodyConverter = {
  method: 'basic',
  htmlToText: basicHtmlToText,
};
