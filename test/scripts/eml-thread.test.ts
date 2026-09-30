import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../scripts/bundle.ts';
import { EmlParseError, emlToThread, nodeDecodeUtf8 } from '../../scripts/eml-thread.ts';
import type { GmailMessagePart, GmailThread } from '../../src/core/gmail-types.ts';
import { threadToState } from '../../src/core/thread-state.ts';
import { nodeDecodeUtf8 as testDecodeUtf8 } from '../fakes/node-utf8.ts';

const EML = join(REPO_ROOT, 'test', 'fixtures', 'eml');
const GMAIL = join(REPO_ROOT, 'test', 'fixtures', 'gmail');

/** Spike 29 scenarios with an `.eml` twin in test/fixtures/eml/. */
const SCENARIOS = [
  '01-plain-utf8-7bit',
  '02-html-utf8-qp',
  '03-alternative-utf8-base64',
  '04-mixed-attachments',
  '05-plain-iso-8859-1-qp',
  '06-html-windows-1252-qp',
  '07-plain-multibyte-base64',
  '08-plain-no-charset-8bit',
  '09-plain-unknown-charset',
  '09b-plain-unknown-charset-latin1',
  '10-rfc2047-headers',
  '14-forward-as-attachment',
  '14b-forward-inline-rfc822',
];

function readEml(name: string): Uint8Array {
  return readFileSync(join(EML, `${name}.eml`));
}

function fromEml(name: string): GmailThread {
  return emlToThread(readEml(name), name);
}

function gmailFixture(name: string): GmailThread {
  return JSON.parse(readFileSync(join(GMAIL, `${name}.json`), 'utf8')) as GmailThread;
}

function expectedTexts(name: string): Record<string, string> {
  return JSON.parse(readFileSync(join(GMAIL, `${name}.expected.json`), 'utf8')) as Record<
    string,
    string
  >;
}

function payload(thread: GmailThread): GmailMessagePart {
  const part = thread.messages?.[0]?.payload;
  if (part === undefined) throw new Error('no payload');
  return part;
}

function flatten(part: GmailMessagePart): GmailMessagePart[] {
  return [part, ...(part.parts ?? []).flatMap(flatten)];
}

/** What the tree must share with Gmail's: ids, types, names, sizes, and inline or attached. */
function shape(part: GmailMessagePart): unknown[] {
  return flatten(part).map((p) => ({
    partId: p.partId,
    mimeType: p.mimeType,
    filename: p.filename,
    size: p.body?.size,
    data: p.body?.data !== undefined,
    attachmentId: p.body?.attachmentId !== undefined,
  }));
}

const options = { plainTextMethod: 'basic' as const, questions: ['Is this a newsletter?'] };

describe('emlToThread, against the Gmail fixtures of spike 29', () => {
  describe.each(SCENARIOS)('%s', (name) => {
    const thread = fromEml(name);
    const gmail = gmailFixture(name);

    it('has the same part tree as Gmail', () => {
      expect(shape(payload(thread))).toEqual(shape(payload(gmail)));
    });

    it('decodes each inline text part to the expected text', () => {
      const parts = new Map(flatten(payload(thread)).map((p) => [p.partId, p]));
      const inline = new Set(
        flatten(payload(gmail))
          .filter((p) => p.body?.data !== undefined)
          .map((p) => p.partId),
      );
      // expected.json also holds attachments' text, which Gmail doesn't inline.
      const texts = Object.entries(expectedTexts(name)).filter(([partId]) => inline.has(partId));
      expect(texts.length).toBeGreaterThan(0);
      for (const [partId, text] of texts) {
        const data = parts.get(partId)?.body?.data;
        expect(data, `part ${partId}`).toBeDefined();
        expect(nodeDecodeUtf8(data ?? [])).toBe(text);
      }
    });

    it('gives nested parts the same headers as Gmail', () => {
      // The fixtures replaced some values with REDACTED (their README): compare names only there.
      const ours = flatten(payload(thread)).slice(1);
      const theirs = flatten(payload(gmail)).slice(1);
      expect(
        ours.map((p, i) =>
          (p.headers ?? []).map((h, j) =>
            theirs[i]?.headers?.[j]?.value === 'REDACTED' ? { ...h, value: 'REDACTED' } : h,
          ),
        ),
      ).toEqual(theirs.map((p) => p.headers));
    });

    it('gives threadToState the same state as the Gmail fixture', () => {
      expect(threadToState(thread, options, testDecodeUtf8)).toEqual(
        threadToState(gmail, options, testDecodeUtf8),
      );
    });

    it('sets the internalDate from the Date header', () => {
      expect(thread.messages?.[0]?.internalDate).toBe(gmail.messages?.[0]?.internalDate);
    });
  });

  it('stores data as signed bytes', () => {
    const data = payload(fromEml('03-alternative-utf8-base64')).parts?.[0]?.body?.data ?? [];
    expect(data.some((b) => b < 0)).toBe(true);
    expect(data.every((b) => b >= -128 && b <= 127)).toBe(true);
  });

  it('transcodes a declared charset to UTF-8 (ISO-8859-1, as windows-1252)', () => {
    const body = payload(fromEml('05-plain-iso-8859-1-qp')).body;
    expect(body?.size).toBe(95);
    expect(body?.data).toHaveLength(105);
  });

  it('decodes and unfolds RFC 2047 headers', () => {
    const headers = new Map(
      (payload(fromEml('10-rfc2047-headers')).headers ?? []).map((h) => [h.name, h.value]),
    );
    expect(headers.get('Subject')).toBe('s29-10 Grüße aus 日本 encoded subject');
    // Gmail quotes a decoded display name.
    expect(headers.get('From')).toBe('"José Müller" <jose@example.com>');
    expect(headers.get('To')).toBe('"Grüße Empfänger" <recipient@example.org>');
  });

  it('builds a one-message thread with the file name as its IDs', () => {
    const thread = fromEml('01-plain-utf8-7bit');
    expect(thread.id).toBe('01-plain-utf8-7bit');
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages?.[0]).toMatchObject({
      id: '01-plain-utf8-7bit',
      threadId: '01-plain-utf8-7bit',
      labelIds: [],
    });
  });

  it('throws EmlParseError for a file with no headers', () => {
    expect(() => emlToThread(readEml('not-mime'), 'not-mime')).toThrow(EmlParseError);
  });
});

describe('emlToThread, on hand-built input', () => {
  const eml = (text: string): GmailThread => emlToThread(Buffer.from(text, 'utf8'), 'x');

  it('defaults to text/plain and omits internalDate for a bad Date', () => {
    const thread = eml('Subject: hi\r\nDate: not a date\r\n\r\nHello\r\n');
    expect(payload(thread)).toMatchObject({ partId: '', mimeType: 'text/plain', filename: '' });
    expect(thread.messages?.[0]).not.toHaveProperty('internalDate');
  });

  it('accepts bare LF line endings', () => {
    const thread = eml(
      'Subject: lf\nContent-Type: multipart/alternative; boundary=b\n\n--b\nContent-Type: text/plain\n\nOne\n--b--\n',
    );
    expect(nodeDecodeUtf8(payload(thread).parts?.[0]?.body?.data ?? [])).toBe('One');
  });

  it('runs the last part to the end when the closing boundary is missing', () => {
    const thread = eml(
      'Subject: open\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\n\r\nTail text\r\n',
    );
    expect(nodeDecodeUtf8(payload(thread).parts?.[0]?.body?.data ?? [])).toBe('Tail text\r\n');
  });

  it('treats a multipart without a boundary as an attachment', () => {
    const thread = eml('Subject: nb\r\nContent-Type: multipart/mixed\r\n\r\nstuff\r\n');
    expect(payload(thread).body).toEqual({ size: 7, attachmentId: 'eml-' });
  });

  it('decodes bad base64 leniently', () => {
    const thread = eml(
      'Subject: b64\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVs!!bG8=\r\n',
    );
    expect(nodeDecodeUtf8(payload(thread).body?.data ?? [])).toBe('Hello');
  });

  it('reads an RFC 2231 filename in sections', () => {
    const thread = eml(
      [
        'Subject: f',
        'Content-Type: multipart/mixed; boundary=b',
        '',
        '--b',
        'Content-Type: application/octet-stream',
        "Content-Disposition: attachment; filename*0*=UTF-8''caf%C3%A9; filename*1=\".txt\"",
        '',
        'x',
        '--b--',
      ].join('\r\n'),
    );
    expect(payload(thread).parts?.[0]).toMatchObject({
      filename: 'café.txt',
      body: { size: 1, attachmentId: 'eml-0' },
    });
  });

  it('reads an RFC 2047 name parameter when there is no Content-Disposition', () => {
    const thread = eml(
      'Subject: n\r\nContent-Type: text/plain; name="=?UTF-8?B?w6kudHh0?="\r\n\r\nx',
    );
    expect(payload(thread)).toMatchObject({
      filename: 'é.txt',
      body: { size: 1, attachmentId: 'eml-' },
    });
  });

  it('falls back to windows-1252 for invalid UTF-8 with no charset', () => {
    const raw = Buffer.concat([
      Buffer.from('Subject: l\r\n\r\ncaf', 'latin1'),
      Buffer.from([0xe9]),
    ]);
    expect(nodeDecodeUtf8(payload(emlToThread(raw, 'l')).body?.data ?? [])).toBe('café');
  });
});
