import { describe, expect, it } from 'vitest';

import { isExcludedPart } from '../../../src/core/body/parts.ts';
import type { GmailMessagePart, GmailThread } from '../../../src/core/gmail-types.ts';
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

describe('isExcludedPart', () => {
  const cases: readonly [string, GmailMessagePart, boolean][] = [
    ['empty filename, no attachmentId', { filename: '', mimeType: 'text/plain' }, false],
    ['nothing set', {}, false],
    ['empty filename, body without attachmentId', { filename: '', body: { size: 3 } }, false],
    ['filename only', { filename: 'a.txt', mimeType: 'text/plain' }, true],
    ['attachmentId only', { filename: '', body: { attachmentId: 'ANGj' } }, true],
    ['attachmentId, filename absent', { body: { attachmentId: 'ANGj' } }, true],
    ['filename and attachmentId', { filename: 'a.pdf', body: { attachmentId: 'ANGj' } }, true],
    ['message/rfc822', { filename: '', mimeType: 'message/rfc822' }, true],
    ['MESSAGE/RFC822', { filename: '', mimeType: 'MESSAGE/RFC822' }, true],
    ['Message/Rfc822', { filename: '', mimeType: 'Message/Rfc822' }, true],
    ['multipart/mixed', { filename: '', mimeType: 'multipart/mixed' }, false],
    ['multipart/alternative', { filename: '', mimeType: 'multipart/alternative' }, false],
    ['text/html', { filename: '', mimeType: 'text/html' }, false],
    ['text/calendar without markers', { filename: '', mimeType: 'text/calendar' }, false],
  ];

  it.each(cases)('%s', (_name, part, expected) => {
    expect(isExcludedPart(part)).toBe(expected);
  });
});

function allParts(part: GmailMessagePart | undefined): GmailMessagePart[] {
  if (part === undefined) {
    return [];
  }
  return [part, ...(part.parts ?? []).flatMap(allParts)];
}

function threadParts(thread: GmailThread): GmailMessagePart[] {
  return (thread.messages ?? []).flatMap((message) => allParts(message.payload));
}

describe('isExcludedPart on fixtures', () => {
  const cases: readonly [string, GmailThread, string[]][] = [
    ['04-mixed-attachments', mixedAttachments, ['1', '2']],
    ['13-calendar-invite', calendarInvite, ['0.2', '1']],
    ['14-forward-as-attachment', forwardAsAttachment, ['1']],
    ['14b-forward-inline-rfc822', forwardInline, ['1']],
    ['01-plain-utf8-7bit', plainUtf8, []],
    ['02-html-utf8-qp', htmlQp, []],
    ['03-alternative-utf8-base64', alternative, []],
    ['03b-alternative-utf8-base64-import', alternativeImport, []],
    ['05-plain-iso-8859-1-qp', latin1, []],
    ['05b-plain-iso-8859-1-qp-import', latin1Import, []],
    ['06-html-windows-1252-qp', windows1252, []],
    ['07-plain-multibyte-base64', multibyte, []],
    ['08-plain-no-charset-8bit', noCharset, []],
    ['09-plain-unknown-charset', unknownCharset, []],
    ['09b-plain-unknown-charset-latin1', unknownCharsetLatin1, []],
    ['10-rfc2047-headers', rfc2047, []],
    ['11-large-plain', largePlain, []],
    ['12-gmail-composed-html', gmailComposed, []],
  ];

  it.each(cases)('%s excludes exactly the expected partIds', (_name, thread, expected) => {
    const excluded = threadParts(thread)
      .filter(isExcludedPart)
      .map((part) => part.partId);
    expect(excluded).toEqual(expected);
  });

  it.each([
    ['14-forward-as-attachment', forwardAsAttachment],
    ['14b-forward-inline-rfc822', forwardInline],
  ] as const)(
    '%s: inner parts are not excluded by themselves, so the walker must not descend',
    (_name, thread) => {
      const inner = threadParts(thread).filter((part) => part.partId?.startsWith('1.') === true);
      expect(inner.length).toBeGreaterThan(0);
      expect(inner.some(isExcludedPart)).toBe(false);
    },
  );
});
