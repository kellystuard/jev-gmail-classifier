import { describe, expect, it } from 'vitest';

import type { GmailMessagePart, GmailThread } from '../../src/core/gmail-types.ts';
import f01_plain_utf8_7bit from '../fixtures/gmail/01-plain-utf8-7bit.json' with { type: 'json' };
import f01_plain_utf8_7bitExpected from '../fixtures/gmail/01-plain-utf8-7bit.expected.json' with { type: 'json' };
import f02_html_utf8_qp from '../fixtures/gmail/02-html-utf8-qp.json' with { type: 'json' };
import f02_html_utf8_qpExpected from '../fixtures/gmail/02-html-utf8-qp.expected.json' with { type: 'json' };
import f03_alternative_utf8_base64 from '../fixtures/gmail/03-alternative-utf8-base64.json' with { type: 'json' };
import f03_alternative_utf8_base64Expected from '../fixtures/gmail/03-alternative-utf8-base64.expected.json' with { type: 'json' };
import f03b_alternative_utf8_base64_import from '../fixtures/gmail/03b-alternative-utf8-base64-import.json' with { type: 'json' };
import f03b_alternative_utf8_base64_importExpected from '../fixtures/gmail/03b-alternative-utf8-base64-import.expected.json' with { type: 'json' };
import f04_mixed_attachments from '../fixtures/gmail/04-mixed-attachments.json' with { type: 'json' };
import f04_mixed_attachmentsExpected from '../fixtures/gmail/04-mixed-attachments.expected.json' with { type: 'json' };
import f05_plain_iso_8859_1_qp from '../fixtures/gmail/05-plain-iso-8859-1-qp.json' with { type: 'json' };
import f05_plain_iso_8859_1_qpExpected from '../fixtures/gmail/05-plain-iso-8859-1-qp.expected.json' with { type: 'json' };
import f05b_plain_iso_8859_1_qp_import from '../fixtures/gmail/05b-plain-iso-8859-1-qp-import.json' with { type: 'json' };
import f05b_plain_iso_8859_1_qp_importExpected from '../fixtures/gmail/05b-plain-iso-8859-1-qp-import.expected.json' with { type: 'json' };
import f06_html_windows_1252_qp from '../fixtures/gmail/06-html-windows-1252-qp.json' with { type: 'json' };
import f06_html_windows_1252_qpExpected from '../fixtures/gmail/06-html-windows-1252-qp.expected.json' with { type: 'json' };
import f07_plain_multibyte_base64 from '../fixtures/gmail/07-plain-multibyte-base64.json' with { type: 'json' };
import f07_plain_multibyte_base64Expected from '../fixtures/gmail/07-plain-multibyte-base64.expected.json' with { type: 'json' };
import f08_plain_no_charset_8bit from '../fixtures/gmail/08-plain-no-charset-8bit.json' with { type: 'json' };
import f08_plain_no_charset_8bitExpected from '../fixtures/gmail/08-plain-no-charset-8bit.expected.json' with { type: 'json' };
import f09_plain_unknown_charset from '../fixtures/gmail/09-plain-unknown-charset.json' with { type: 'json' };
import f09_plain_unknown_charsetExpected from '../fixtures/gmail/09-plain-unknown-charset.expected.json' with { type: 'json' };
import f09b_plain_unknown_charset_latin1 from '../fixtures/gmail/09b-plain-unknown-charset-latin1.json' with { type: 'json' };
import f09b_plain_unknown_charset_latin1Expected from '../fixtures/gmail/09b-plain-unknown-charset-latin1.expected.json' with { type: 'json' };
import f10_rfc2047_headers from '../fixtures/gmail/10-rfc2047-headers.json' with { type: 'json' };
import f10_rfc2047_headersExpected from '../fixtures/gmail/10-rfc2047-headers.expected.json' with { type: 'json' };
import f11_large_plain from '../fixtures/gmail/11-large-plain.json' with { type: 'json' };
import f11_large_plainExpected from '../fixtures/gmail/11-large-plain.expected.json' with { type: 'json' };
import f12_gmail_composed_html from '../fixtures/gmail/12-gmail-composed-html.json' with { type: 'json' };
import f12_gmail_composed_htmlExpected from '../fixtures/gmail/12-gmail-composed-html.expected.json' with { type: 'json' };
import f13_calendar_invite from '../fixtures/gmail/13-calendar-invite.json' with { type: 'json' };
import f13_calendar_inviteExpected from '../fixtures/gmail/13-calendar-invite.expected.json' with { type: 'json' };
import f14_forward_as_attachment from '../fixtures/gmail/14-forward-as-attachment.json' with { type: 'json' };
import f14_forward_as_attachmentExpected from '../fixtures/gmail/14-forward-as-attachment.expected.json' with { type: 'json' };
import f14b_forward_inline_rfc822 from '../fixtures/gmail/14b-forward-inline-rfc822.json' with { type: 'json' };
import f14b_forward_inline_rfc822Expected from '../fixtures/gmail/14b-forward-inline-rfc822.expected.json' with { type: 'json' };
import { nodeDecodeUtf8 } from './node-utf8.ts';

// The assignments are typed, so a fixture that drifts from the types fails `npm run typecheck`.
const fixtures: readonly (readonly [string, GmailThread, Record<string, string>])[] = [
  ['01-plain-utf8-7bit', f01_plain_utf8_7bit, f01_plain_utf8_7bitExpected],
  ['02-html-utf8-qp', f02_html_utf8_qp, f02_html_utf8_qpExpected],
  ['03-alternative-utf8-base64', f03_alternative_utf8_base64, f03_alternative_utf8_base64Expected],
  [
    '03b-alternative-utf8-base64-import',
    f03b_alternative_utf8_base64_import,
    f03b_alternative_utf8_base64_importExpected,
  ],
  ['04-mixed-attachments', f04_mixed_attachments, f04_mixed_attachmentsExpected],
  ['05-plain-iso-8859-1-qp', f05_plain_iso_8859_1_qp, f05_plain_iso_8859_1_qpExpected],
  [
    '05b-plain-iso-8859-1-qp-import',
    f05b_plain_iso_8859_1_qp_import,
    f05b_plain_iso_8859_1_qp_importExpected,
  ],
  ['06-html-windows-1252-qp', f06_html_windows_1252_qp, f06_html_windows_1252_qpExpected],
  ['07-plain-multibyte-base64', f07_plain_multibyte_base64, f07_plain_multibyte_base64Expected],
  ['08-plain-no-charset-8bit', f08_plain_no_charset_8bit, f08_plain_no_charset_8bitExpected],
  ['09-plain-unknown-charset', f09_plain_unknown_charset, f09_plain_unknown_charsetExpected],
  [
    '09b-plain-unknown-charset-latin1',
    f09b_plain_unknown_charset_latin1,
    f09b_plain_unknown_charset_latin1Expected,
  ],
  ['10-rfc2047-headers', f10_rfc2047_headers, f10_rfc2047_headersExpected],
  ['11-large-plain', f11_large_plain, f11_large_plainExpected],
  ['12-gmail-composed-html', f12_gmail_composed_html, f12_gmail_composed_htmlExpected],
  ['13-calendar-invite', f13_calendar_invite, f13_calendar_inviteExpected],
  ['14-forward-as-attachment', f14_forward_as_attachment, f14_forward_as_attachmentExpected],
  ['14b-forward-inline-rfc822', f14b_forward_inline_rfc822, f14b_forward_inline_rfc822Expected],
];

function allParts(part: GmailMessagePart | undefined): GmailMessagePart[] {
  if (part === undefined) {
    return [];
  }
  return [part, ...(part.parts ?? []).flatMap(allParts)];
}

describe('nodeDecodeUtf8', () => {
  it('finds all 18 fixtures', () => {
    expect(fixtures).toHaveLength(18);
  });

  it('decodes every inline text part of every fixture to its expected text', () => {
    let checked = 0;
    for (const [name, thread, expected] of fixtures) {
      for (const message of thread.messages ?? []) {
        for (const part of allParts(message.payload)) {
          const data = part.body?.data;
          if (data === undefined) {
            continue;
          }
          const partId = part.partId ?? '';
          expect(partId in expected, `${name} part ${partId}`).toBe(true);
          expect(nodeDecodeUtf8(data), `${name} part ${partId}`).toBe(expected[partId]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(32);
  });

  it('decodes the 1 MB fixture', () => {
    const thread: GmailThread = f11_large_plain;
    const data = thread.messages?.[0]?.payload?.body?.data ?? [];
    expect(data.length).toBeGreaterThan(1_000_000);
    expect(nodeDecodeUtf8(data).length).toBeGreaterThan(1_000_000);
  });

  it.each([
    ['empty', [], ''],
    ['ASCII', [72, 105], 'Hi'],
    ['2-byte', [-61, -87], 'é'],
    ['3-byte', [-26, -105, -91], '日'],
    ['4-byte', [-16, -97, -103, -126], '🙂'],
    ['leading BOM kept', [-17, -69, -65, 65], '﻿A'],
    ['invalid byte', [-1], '�'],
  ] as const)('%s', (_name, bytes, text) => {
    expect(nodeDecodeUtf8(bytes)).toBe(text);
  });
});
