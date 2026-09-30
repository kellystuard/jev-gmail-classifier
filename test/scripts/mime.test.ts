import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  decodeAddressWords,
  decodeCharset,
  decodeQuotedPrintable,
  decodeWords,
  parseEntity,
  parseStructured,
  splitMultipart,
} from '../../scripts/mime.ts';

describe('decodeWords', () => {
  it('drops whitespace between adjacent encoded-words only', () => {
    expect(decodeWords('a =?UTF-8?Q?b?= =?UTF-8?Q?c?= d')).toBe('a bc d');
  });

  it('leaves an encoded-word with an unknown charset as written', () => {
    expect(decodeWords('=?x-nope?Q?a?=')).toBe('=?x-nope?Q?a?=');
  });

  it('accepts an RFC 2231 language suffix', () => {
    expect(decodeWords('=?UTF-8*en?Q?caf=C3=A9?=')).toBe('café');
  });
});

describe('decodeAddressWords', () => {
  it('quotes a decoded display name and escapes quotes in it', () => {
    expect(decodeAddressWords('=?UTF-8?Q?A_=22B=22?= <a@example.com>')).toBe(
      '"A \\"B\\"" <a@example.com>',
    );
  });

  it("doesn't quote twice inside a quoted string", () => {
    expect(decodeAddressWords('"=?UTF-8?Q?Jos=C3=A9?=" <j@example.com>')).toBe(
      '"José" <j@example.com>',
    );
  });
});

describe('decodeCharset', () => {
  it('reads iso-8859-1 as windows-1252', () => {
    expect(decodeCharset(Buffer.from([0x80]), 'iso-8859-1')).toBe('€');
  });

  it('guesses UTF-8, then windows-1252, for an unknown label', () => {
    expect(decodeCharset(Buffer.from('é', 'utf8'), 'x-unknown')).toBe('é');
    expect(decodeCharset(Buffer.from([0xe9]), 'x-unknown')).toBe('é');
  });

  it('keeps a leading BOM as a character', () => {
    expect(decodeCharset(Buffer.from([0xef, 0xbb, 0xbf, 0x61]), 'utf-8')).toBe('﻿a');
  });
});

describe('parseStructured', () => {
  it('lower-cases the value and parameter names, and unquotes values', () => {
    const header = parseStructured('Text/HTML; Charset="UTF-8"; x="a;b"');
    expect(header.value).toBe('text/html');
    expect(Object.fromEntries(header.params)).toEqual({ charset: 'UTF-8', x: 'a;b' });
  });

  it('decodes an RFC 2231 value without sections', () => {
    const header = parseStructured("attachment; filename*=iso-8859-1'en'caf%E9.txt");
    expect(header.params.get('filename')).toBe('café.txt');
  });

  it('gives an empty value for no header', () => {
    expect(parseStructured(undefined)).toEqual({ value: '', params: new Map() });
  });
});

describe('decodeQuotedPrintable', () => {
  it('removes soft breaks and trailing whitespace, and keeps a stray =', () => {
    expect(decodeQuotedPrintable(Buffer.from('a=3Db =\r\nc  \r\nd=ZZ')).toString('latin1')).toBe(
      'a=b c\r\nd=ZZ',
    );
  });
});

describe('parseEntity', () => {
  it('unfolds continuation lines and skips lines that are not headers', () => {
    const entity = parseEntity(Buffer.from('Subject: a\r\n b\r\nnot a header\r\nX: 1\r\n\r\nbody'));
    expect(entity.headers).toEqual([
      { name: 'Subject', value: 'a b' },
      { name: 'X', value: '1' },
    ]);
    expect(entity.body.toString()).toBe('body');
  });

  it('reads 8-bit header bytes as UTF-8', () => {
    const entity = parseEntity(Buffer.from('Subject: café\r\n\r\n', 'utf8'));
    expect(entity.headers[0]?.value).toBe('café');
  });
});

describe('splitMultipart', () => {
  it('drops the preamble and epilogue, and keeps an empty part', () => {
    const body = Buffer.from('preamble\r\n--b\r\n--b\r\nX: 1\r\n\r\ntwo\r\n--b--\r\nepilogue');
    expect(splitMultipart(body, 'b').map((part) => part.toString())).toEqual([
      '',
      'X: 1\r\n\r\ntwo',
    ]);
  });

  it("doesn't match a longer boundary that starts with this one", () => {
    const body = Buffer.from('--b\r\none\r\n--bb\r\nstill one\r\n--b--');
    expect(splitMultipart(body, 'b').map((part) => part.toString())).toEqual([
      'one\r\n--bb\r\nstill one',
    ]);
  });
});
