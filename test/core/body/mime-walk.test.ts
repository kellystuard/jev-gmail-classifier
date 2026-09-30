import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { selectBodyConverter, type BodyConverter } from '../../../src/core/body/body-converter.ts';
import {
  messageBodyText,
  normalizeBodyText,
  type BodyTextDeps,
} from '../../../src/core/body/mime-walk.ts';
import type { Utf8Decoder } from '../../../src/core/body/utf8.ts';
import type { GmailMessagePart, GmailThread } from '../../../src/core/gmail-types.ts';
import { nodeDecodeUtf8 } from '../../fakes/node-utf8.ts';
import plainUtf8 from '../../fixtures/gmail/01-plain-utf8-7bit.json' with { type: 'json' };
import htmlQp from '../../fixtures/gmail/02-html-utf8-qp.json' with { type: 'json' };
import alternative from '../../fixtures/gmail/03-alternative-utf8-base64.json' with { type: 'json' };
import alternativeImport from '../../fixtures/gmail/03b-alternative-utf8-base64-import.json' with { type: 'json' };
import mixedAttachments from '../../fixtures/gmail/04-mixed-attachments.json' with { type: 'json' };
import latin1 from '../../fixtures/gmail/05-plain-iso-8859-1-qp.json' with { type: 'json' };
import latin1Import from '../../fixtures/gmail/05b-plain-iso-8859-1-qp-import.json' with { type: 'json' };
import windows1252 from '../../fixtures/gmail/06-html-windows-1252-qp.json' with { type: 'json' };
import multibyte from '../../fixtures/gmail/07-plain-multibyte-base64.json' with { type: 'json' };
import noCharset from '../../fixtures/gmail/08-plain-no-charset-8bit.json' with { type: 'json' };
import unknownCharset from '../../fixtures/gmail/09-plain-unknown-charset.json' with { type: 'json' };
import unknownCharsetLatin1 from '../../fixtures/gmail/09b-plain-unknown-charset-latin1.json' with { type: 'json' };
import rfc2047 from '../../fixtures/gmail/10-rfc2047-headers.json' with { type: 'json' };
import largePlain from '../../fixtures/gmail/11-large-plain.json' with { type: 'json' };
import gmailComposed from '../../fixtures/gmail/12-gmail-composed-html.json' with { type: 'json' };
import calendarInvite from '../../fixtures/gmail/13-calendar-invite.json' with { type: 'json' };
import forwardAsAttachment from '../../fixtures/gmail/14-forward-as-attachment.json' with { type: 'json' };
import forwardInline from '../../fixtures/gmail/14b-forward-inline-rfc822.json' with { type: 'json' };

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'gmail');

const basic = selectBodyConverter('basic');

/** The decoded text of one part of a Gmail fixture (`<name>.expected.json`). */
function fixturePart(name: string, partId: string): string {
  const parsed = z
    .record(z.string(), z.string())
    .parse(JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), 'utf8')));
  const text = parsed[partId];
  if (text === undefined) {
    throw new Error(`${name} has no part ${partId}`);
  }
  return text;
}

/** The payload of a fixture's only message. */
function payloadOf(thread: GmailThread): GmailMessagePart | undefined {
  const messages = thread.messages ?? [];
  expect(messages).toHaveLength(1);
  return messages[0]?.payload;
}

/** A converter that marks its output and counts its calls, so the walk's choices are visible. */
function stubConverter(): { converter: BodyConverter; calls: () => number } {
  let calls = 0;
  return {
    converter: {
      method: 'basic',
      htmlToText: (html) => {
        calls++;
        return `HTML:${html}`;
      },
    },
    calls: () => calls,
  };
}

/** `nodeDecodeUtf8`, counting its calls. */
function countingDecoder(): { decodeUtf8: Utf8Decoder; calls: () => number } {
  let calls = 0;
  return {
    decodeUtf8: (bytes) => {
      calls++;
      return nodeDecodeUtf8(bytes);
    },
    calls: () => calls,
  };
}

const basicDeps: BodyTextDeps = { converter: basic, decodeUtf8: nodeDecodeUtf8 };

describe('messageBodyText on fixtures', () => {
  const plain = (name: string, partId: string): string =>
    normalizeBodyText(fixturePart(name, partId));
  const html = (name: string, partId: string): string =>
    normalizeBodyText(basic.htmlToText(fixturePart(name, partId)));

  const cases: readonly [string, GmailThread, () => string][] = [
    ['01-plain-utf8-7bit', plainUtf8, () => plain('01-plain-utf8-7bit', '')],
    ['05-plain-iso-8859-1-qp', latin1, () => plain('05-plain-iso-8859-1-qp', '')],
    [
      '05b-plain-iso-8859-1-qp-import',
      latin1Import,
      () => plain('05b-plain-iso-8859-1-qp-import', ''),
    ],
    [
      '09b-plain-unknown-charset-latin1',
      unknownCharsetLatin1,
      () => plain('09b-plain-unknown-charset-latin1', ''),
    ],
    ['10-rfc2047-headers', rfc2047, () => plain('10-rfc2047-headers', '')],
    ['11-large-plain', largePlain, () => plain('11-large-plain', '')],
    ['02-html-utf8-qp', htmlQp, () => html('02-html-utf8-qp', '')],
    ['06-html-windows-1252-qp', windows1252, () => html('06-html-windows-1252-qp', '')],
    ['03-alternative-utf8-base64', alternative, () => plain('03-alternative-utf8-base64', '0')],
    [
      '03b-alternative-utf8-base64-import',
      alternativeImport,
      () => plain('03b-alternative-utf8-base64-import', '0'),
    ],
    ['12-gmail-composed-html', gmailComposed, () => plain('12-gmail-composed-html', '0')],
    [
      '07-plain-multibyte-base64',
      multibyte,
      () =>
        `${plain('07-plain-multibyte-base64', '0')}\n\n${plain('07-plain-multibyte-base64', '1')}`,
    ],
    [
      '08-plain-no-charset-8bit',
      noCharset,
      () =>
        `${plain('08-plain-no-charset-8bit', '0')}\n\n${plain('08-plain-no-charset-8bit', '1')}`,
    ],
    [
      '09-plain-unknown-charset',
      unknownCharset,
      () =>
        `${plain('09-plain-unknown-charset', '0')}\n\n${plain('09-plain-unknown-charset', '1')}`,
    ],
    ['04-mixed-attachments', mixedAttachments, () => plain('04-mixed-attachments', '0.0')],
    ['13-calendar-invite', calendarInvite, () => plain('13-calendar-invite', '0.0')],
    [
      '14-forward-as-attachment',
      forwardAsAttachment,
      () => plain('14-forward-as-attachment', '0.0'),
    ],
    ['14b-forward-inline-rfc822', forwardInline, () => plain('14b-forward-inline-rfc822', '0.0')],
  ];

  it.each(cases)('%s', (_name, thread, expected) => {
    const text = messageBodyText(payloadOf(thread), basicDeps);
    expect(text).toBe(expected());
    expect(text).not.toBe('');
  });

  it('11-large-plain (1 MB) walks and normalizes quickly', () => {
    const payload = payloadOf(largePlain);
    const start = performance.now();
    const text = messageBodyText(payload, basicDeps);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(text.length).toBeGreaterThan(900_000);
  });

  it.each([
    ['03-alternative-utf8-base64', alternative],
    ['03b-alternative-utf8-base64-import', alternativeImport],
    ['12-gmail-composed-html', gmailComposed],
  ] as const)('%s never calls the converter', (_name, thread) => {
    const stub = stubConverter();
    const text = messageBodyText(payloadOf(thread), {
      converter: stub.converter,
      decodeUtf8: nodeDecodeUtf8,
    });
    expect(stub.calls()).toBe(0);
    expect(text).not.toContain('HTML:');
  });

  it("12 keeps the plain alternative's own hard wrap", () => {
    expect(messageBodyText(payloadOf(gmailComposed), basicDeps)).toContain('Größe\ncafé 日本.');
  });

  it.each([
    ['02-html-utf8-qp', htmlQp],
    ['06-html-windows-1252-qp', windows1252],
  ] as const)('%s goes through the converter once', (_name, thread) => {
    const stub = stubConverter();
    const text = messageBodyText(payloadOf(thread), {
      converter: stub.converter,
      decodeUtf8: nodeDecodeUtf8,
    });
    expect(stub.calls()).toBe(1);
    expect(text.startsWith('HTML:')).toBe(true);
  });

  it.each([
    ['14-forward-as-attachment', forwardAsAttachment],
    ['14b-forward-inline-rfc822', forwardInline],
  ] as const)('%s never reaches the forwarded message', (_name, thread) => {
    const text = messageBodyText(payloadOf(thread), basicDeps);
    expect(text).toBe('Scenario 14: forwarded message attached.');
    expect(text).not.toContain('Inner message of scenario 14');
  });

  it.each([
    ['03-alternative-utf8-base64', alternative],
    ['04-mixed-attachments', mixedAttachments],
  ] as const)('%s decodes only the chosen part', (_name, thread) => {
    const decoder = countingDecoder();
    messageBodyText(payloadOf(thread), { converter: basic, decodeUtf8: decoder.decodeUtf8 });
    expect(decoder.calls()).toBe(1);
  });
});

/** UTF-8 as signed bytes, the form Gmail's `body.data` takes. */
function bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text), (b) => (b > 127 ? b - 256 : b));
}

function leaf(
  mimeType: string,
  text: string,
  extra: Partial<GmailMessagePart> = {},
): GmailMessagePart {
  const data = bytes(text);
  return { mimeType, filename: '', body: { size: data.length, data }, ...extra };
}

function multipart(
  mimeType: string,
  parts: readonly GmailMessagePart[],
  extra: Partial<GmailMessagePart> = {},
): GmailMessagePart {
  return { mimeType, filename: '', body: { size: 0 }, parts, ...extra };
}

describe('messageBodyText on inline trees', () => {
  const walk = (payload: GmailMessagePart | undefined): { text: string; htmlCalls: number } => {
    const stub = stubConverter();
    const text = messageBodyText(payload, {
      converter: stub.converter,
      decodeUtf8: nodeDecodeUtf8,
    });
    return { text, htmlCalls: stub.calls() };
  };

  it('alternative with HTML first, then plain: plain, HTML never converted', () => {
    const result = walk(
      multipart('multipart/alternative', [
        leaf('text/html', '<p>rich</p>'),
        leaf('text/plain', 'plain'),
      ]),
    );
    expect(result).toEqual({ text: 'plain', htmlCalls: 0 });
  });

  it('alternative with only HTML: converted', () => {
    expect(walk(multipart('multipart/alternative', [leaf('text/html', '<p>rich</p>')]))).toEqual({
      text: 'HTML:<p>rich</p>',
      htmlCalls: 1,
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace', ' \r\n\t\n'],
  ])('alternative whose plain part is %s: falls back to HTML', (_name, plainText) => {
    const decoder = countingDecoder();
    const stub = stubConverter();
    const text = messageBodyText(
      multipart('multipart/alternative', [
        leaf('text/plain', plainText),
        leaf('text/html', 'rich'),
      ]),
      { converter: stub.converter, decodeUtf8: decoder.decodeUtf8 },
    );
    expect(text).toBe('HTML:rich');
    expect(stub.calls()).toBe(1);
    // No part is decoded twice, even when both passes visit it.
    expect(decoder.calls()).toBe(plainText === '' ? 1 : 2);
  });

  it('alternative whose first child is multipart/related (HTML + image) and second is plain: plain', () => {
    const related = multipart('multipart/related', [
      leaf('text/html', '<p>rich</p>'),
      { mimeType: 'image/png', filename: 'logo.png', body: { size: 10, attachmentId: 'att-1' } },
    ]);
    expect(
      walk(multipart('multipart/alternative', [related, leaf('text/plain', 'plain')])),
    ).toEqual({
      text: 'plain',
      htmlCalls: 0,
    });
  });

  it('nested alternative inside mixed with a trailing text/plain footer: both, joined', () => {
    const tree = multipart('multipart/mixed', [
      multipart('multipart/alternative', [
        leaf('text/plain', 'body\r\n'),
        leaf('text/html', '<p>body</p>'),
      ]),
      leaf('text/plain', '-- \r\nfooter\r\n'),
    ]);
    expect(walk(tree)).toEqual({ text: 'body\n\n--\nfooter', htmlCalls: 0 });
  });

  it('multipart/related with HTML and an image: HTML only', () => {
    const tree = multipart('multipart/related', [
      leaf('text/html', 'rich'),
      { mimeType: 'image/png', filename: 'logo.png', body: { size: 10, attachmentId: 'att-1' } },
    ]);
    expect(walk(tree)).toEqual({ text: 'HTML:rich', htmlCalls: 1 });
  });

  it('matches MIME types case-insensitively and ignores surrounding space', () => {
    const tree = multipart('Multipart/Alternative', [
      leaf(' TEXT/PLAIN ', 'plain'),
      leaf('Text/HTML', 'rich'),
    ]);
    expect(walk(tree)).toEqual({ text: 'plain', htmlCalls: 0 });
    expect(walk(leaf('TEXT/HTML', 'rich'))).toEqual({ text: 'HTML:rich', htmlCalls: 1 });
  });

  it.each([
    ['application/json', leaf('application/json', '{"a":1}')],
    ['text/calendar without a filename', leaf('text/calendar', 'BEGIN:VCALENDAR')],
    ['no mimeType', { filename: '', body: { data: bytes('text') } }],
    ['text/plain without data', { mimeType: 'text/plain', filename: '', body: { size: 0 } }],
    ['text/html without body', { mimeType: 'text/html', filename: '' }],
    [
      'text/plain with empty data',
      { mimeType: 'text/plain', filename: '', body: { size: 0, data: [] } },
    ],
  ] as const)('a %s leaf gives nothing', (_name, part: GmailMessagePart) => {
    expect(walk(part)).toEqual({ text: '', htmlCalls: 0 });
  });

  it('an unread leaf in a mixed part is skipped', () => {
    const tree = multipart('multipart/mixed', [
      leaf('text/plain', 'a'),
      leaf('text/calendar', 'cal'),
      leaf('text/plain', 'b'),
    ]);
    expect(walk(tree).text).toBe('a\n\nb');
  });

  it("doesn't descend into a text leaf's own parts", () => {
    const tree = leaf('text/plain', 'outer', { parts: [leaf('text/plain', 'inner')] });
    expect(walk(tree).text).toBe('outer');
  });

  it('joins the children of an unknown container that has parts', () => {
    const tree = multipart('application/x-container', [
      leaf('text/plain', 'a'),
      leaf('text/plain', 'b'),
    ]);
    expect(walk(tree).text).toBe('a\n\nb');
  });

  it('joins the children of multipart/signed, skipping the signature', () => {
    const tree = multipart('multipart/signed', [
      leaf('text/plain', 'signed body'),
      {
        mimeType: 'application/pgp-signature',
        filename: 'signature.asc',
        body: { size: 5, attachmentId: 'att-2' },
      },
    ]);
    expect(walk(tree).text).toBe('signed body');
  });

  it.each([
    ['a filename', { filename: 'fwd.eml' }],
    ['an attachmentId', { body: { size: 0, attachmentId: 'att-3' } }],
  ] as const)('a container with %s contributes nothing from its subtree', (_name, extra) => {
    const tree = multipart('multipart/mixed', [
      leaf('text/plain', 'kept'),
      multipart(
        'multipart/alternative',
        [leaf('text/plain', 'hidden'), leaf('text/html', 'hidden')],
        extra,
      ),
    ]);
    expect(walk(tree)).toEqual({ text: 'kept', htmlCalls: 0 });
  });

  it('an inline message/rfc822 contributes nothing from its subtree', () => {
    const decoder = countingDecoder();
    const tree = multipart('multipart/mixed', [
      leaf('text/plain', 'kept'),
      multipart('message/rfc822', [
        multipart('multipart/alternative', [
          leaf('text/plain', 'hidden'),
          leaf('text/html', 'hidden'),
        ]),
      ]),
    ]);
    const text = messageBodyText(tree, { converter: basic, decodeUtf8: decoder.decodeUtf8 });
    expect(text).toBe('kept');
    expect(decoder.calls()).toBe(1);
  });

  it('an excluded payload gives nothing', () => {
    expect(walk(leaf('text/plain', 'attached', { filename: 'a.txt' })).text).toBe('');
  });

  it.each([
    ['a missing payload', undefined],
    ['an empty multipart/mixed', multipart('multipart/mixed', [])],
    ['a multipart/alternative with no parts', { mimeType: 'multipart/alternative', filename: '' }],
    ['an empty object', {}],
  ] as const)('%s gives an empty string', (_name, payload: GmailMessagePart | undefined) => {
    expect(walk(payload).text).toBe('');
  });

  it('normalizes CRLF, trailing spaces and extra blank lines', () => {
    expect(
      walk(leaf('text/plain', '\r\n  one  \r\ntwo\t\r\n\r\n\r\n\r\nthree\rfour  \r\n')).text,
    ).toBe('one\ntwo\n\nthree\nfour');
  });

  it('keeps leading indentation inside the text', () => {
    expect(walk(leaf('text/plain', 'a\n    indented\nb')).text).toBe('a\n    indented\nb');
  });
});

describe('normalizeBodyText', () => {
  const rows: readonly [string, string, string][] = [
    ['empty', '', ''],
    ['only whitespace', ' \r\n\t \n ', ''],
    ['CRLF', 'a\r\nb', 'a\nb'],
    ['lone CR', 'a\rb', 'a\nb'],
    ['CR CR LF', 'a\r\r\nb', 'a\n\nb'],
    ['trailing spaces and tabs', 'a \t\nb  ', 'a\nb'],
    ['one blank line is kept', 'a\n\nb', 'a\n\nb'],
    ['three blank lines become one', 'a\n\n\n\nb', 'a\n\nb'],
    ['whitespace-only lines count as blank', 'a\n  \n\t\n \nb', 'a\n\nb'],
    ['leading and trailing blank lines', '\n\n a\n\n', 'a'],
    ['leading spaces within lines are kept', 'a\n  b', 'a\n  b'],
    ['no change', 'already\n\nnormal', 'already\n\nnormal'],
  ];

  it.each(rows)('%s', (_name, input, output) => {
    expect(normalizeBodyText(input)).toBe(output);
  });

  it.each(rows)('is idempotent: %s', (_name, input) => {
    const once = normalizeBodyText(input);
    expect(normalizeBodyText(once)).toBe(once);
  });

  it("leaves basic's output unchanged", () => {
    const text = basic.htmlToText('<p>one</p><p>two<br><br><br>three</p><ul><li>x</li></ul>');
    expect(normalizeBodyText(text)).toBe(text);
  });

  it('is linear on a large input', () => {
    const input = `${'word  \r\n\r\n\r\n'.repeat(100_000)}${' '.repeat(500_000)}x`;
    const start = performance.now();
    const text = normalizeBodyText(input);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(text.startsWith('word\n\nword')).toBe(true);
  });
});
