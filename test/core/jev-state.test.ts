import { describe, expect, it } from 'vitest';

import { selectBodyConverter } from '../../src/core/body/body-converter.ts';
import { messageBodyText } from '../../src/core/body/mime-walk.ts';
import type {
  GmailHeader,
  GmailMessage,
  GmailMessagePart,
  GmailThread,
} from '../../src/core/gmail-types.ts';
import { buildState, STATE_HEADER_KEYS } from '../../src/core/jev-state.ts';
import { nodeDecodeUtf8 } from '../fakes/node-utf8.ts';
import plainUtf8 from '../fixtures/gmail/01-plain-utf8-7bit.json' with { type: 'json' };
import htmlQp from '../fixtures/gmail/02-html-utf8-qp.json' with { type: 'json' };
import alternative from '../fixtures/gmail/03-alternative-utf8-base64.json' with { type: 'json' };
import alternativeImport from '../fixtures/gmail/03b-alternative-utf8-base64-import.json' with { type: 'json' };
import mixedAttachments from '../fixtures/gmail/04-mixed-attachments.json' with { type: 'json' };
import rfc2047 from '../fixtures/gmail/10-rfc2047-headers.json' with { type: 'json' };
import gmailComposed from '../fixtures/gmail/12-gmail-composed-html.json' with { type: 'json' };
import calendarInvite from '../fixtures/gmail/13-calendar-invite.json' with { type: 'json' };
import forwardAsAttachment from '../fixtures/gmail/14-forward-as-attachment.json' with { type: 'json' };
import forwardInline from '../fixtures/gmail/14b-forward-inline-rfc822.json' with { type: 'json' };

const deps = { converter: selectBodyConverter('basic'), decodeUtf8: nodeDecodeUtf8 };

/** UTF-8 bytes as Gmail returns them: signed. */
function bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text), (b) => (b > 127 ? b - 256 : b));
}

function plainPart(text: string, headers: readonly GmailHeader[] = []): GmailMessagePart {
  return { mimeType: 'text/plain', headers, body: { data: bytes(text) } };
}

function message(id: string, overrides: Partial<GmailMessage> = {}): GmailMessage {
  return { id, threadId: 't', payload: plainPart(`body ${id}`), ...overrides };
}

function thread(...messages: GmailMessage[]): GmailThread {
  return { id: 't', messages };
}

function ids(state: readonly { body?: string }[]): (string | undefined)[] {
  return state.map((m) => m.body?.replace('body ', ''));
}

/** The only message of a fixture, whose state has exactly one entry. */
function only(fixture: GmailThread): { state: Record<string, string>; payload: GmailMessagePart } {
  const [state, ...rest] = buildState(fixture, deps);
  expect(rest).toHaveLength(0);
  const payload = fixture.messages?.[0]?.payload;
  if (state === undefined || payload === undefined) throw new Error('fixture has no message');
  return { state: { ...state }, payload };
}

describe('buildState: fixtures', () => {
  it('01: from, to, subject, date, body in that order and nothing else', () => {
    const { state, payload } = only(plainUtf8);
    expect(Object.keys(state)).toEqual(['from', 'to', 'subject', 'date', 'body']);
    expect(state['body']).toBe(messageBodyText(payload, deps));
    expect(state['body']).toContain('Scenario 1');
  });

  it('03b: ignores trace and MIME headers, same keys as 03', () => {
    const plain = only(alternative).state;
    const imported = only(alternativeImport).state;
    expect(Object.keys(imported)).toEqual(Object.keys(plain));
    expect(JSON.stringify(imported)).not.toContain('REDACTED');
  });

  it('10: keeps decoded non-ASCII header values unchanged', () => {
    const { state, payload } = only(rfc2047);
    const header = (name: string): string | undefined =>
      payload.headers?.find((h) => h.name === name)?.value.trim();
    expect(state['from']).toBe(header('From'));
    expect(state['to']).toBe(header('To'));
    expect(state['subject']).toBe(header('Subject'));
    expect(Array.from(state['from'] ?? '').some((c) => c.charCodeAt(0) > 127)).toBe(true);
    expect(state['from']).toContain('"');
  });

  it('04 and 13: the body is the body text only', () => {
    for (const fixture of [mixedAttachments, calendarInvite]) {
      const { state, payload } = only(fixture);
      expect(state['body']).toBe(messageBodyText(payload, deps));
      expect(state['body']).not.toContain('BEGIN:VCALENDAR');
      expect(state['body']).not.toContain('%PDF');
    }
  });

  it('14 and 14b: the outer headers and text, none of the inner message', () => {
    for (const fixture of [forwardAsAttachment, forwardInline]) {
      const { state, payload } = only(fixture);
      const inner = payload.parts?.find((p) => p.partId === '1');
      const innerSubject = inner?.parts?.[0]?.headers?.find((h) => h.name === 'Subject')?.value;
      expect(innerSubject).toBeDefined();
      expect(state['subject']).not.toBe(innerSubject);
      expect(state['body']).toContain('forwarded message');
      expect(state['body']).not.toContain('Inner message');
    }
  });

  it('02: HTML-only is converted to text', () => {
    const { state } = only(htmlQp);
    expect(state['body']).toBeTruthy();
    expect(state['body']).not.toMatch(/<[a-z]/i);
  });

  it('12: a SENT message is kept', () => {
    expect(gmailComposed.messages[0]?.labelIds).toContain('SENT');
    expect(buildState(gmailComposed, deps)).toHaveLength(1);
  });
});

describe('buildState: order', () => {
  it('sorts newest first', () => {
    const state = buildState(
      thread(
        message('a', { internalDate: '100' }),
        message('c', { internalDate: '300' }),
        message('b', { internalDate: '200' }),
      ),
      deps,
    );
    expect(ids(state)).toEqual(['c', 'b', 'a']);
  });

  it('keeps thread order for equal dates', () => {
    const state = buildState(
      thread(
        message('a', { internalDate: '100' }),
        message('b', { internalDate: '100' }),
        message('c', { internalDate: '100' }),
      ),
      deps,
    );
    expect(ids(state)).toEqual(['a', 'b', 'c']);
  });

  it.each([
    { label: 'missing' },
    { label: '""', value: '' },
    { label: '"abc"', value: 'abc' },
    { label: '"1.5"', value: '1.5' },
  ])('sorts a message with a $label date last, in thread order', ({ value }) => {
    const bad = value === undefined ? {} : { internalDate: value };
    const state = buildState(
      thread(
        message('x', bad),
        message('a', { internalDate: '100' }),
        message('y', bad),
        message('b', { internalDate: '200' }),
      ),
      deps,
    );
    expect(ids(state)).toEqual(['b', 'a', 'x', 'y']);
  });
});

describe('buildState: filtering', () => {
  it.each([['DRAFT'], ['SPAM'], ['TRASH']])(
    'leaves out a %s message, alone or with other labels',
    (label) => {
      for (const labelIds of [[label], ['INBOX', label], ['SENT', label]]) {
        const state = buildState(
          thread(message('keep', { internalDate: '1' }), message('drop', { labelIds })),
          deps,
        );
        expect(ids(state)).toEqual(['keep']);
      }
    },
  );

  it('keeps INBOX and SENT messages', () => {
    const state = buildState(
      thread(
        message('a', { labelIds: ['INBOX'], internalDate: '2' }),
        message('b', { labelIds: ['SENT'], internalDate: '1' }),
      ),
      deps,
    );
    expect(ids(state)).toEqual(['a', 'b']);
  });

  it('returns [] when all are left out, or there are none', () => {
    expect(buildState(thread(message('a', { labelIds: ['DRAFT'] })), deps)).toEqual([]);
    expect(buildState({ id: 't' }, deps)).toEqual([]);
    expect(buildState({ id: 't', messages: [] }, deps)).toEqual([]);
  });
});

describe('buildState: headers', () => {
  const all: GmailHeader[] = [
    { name: 'Auto-Submitted', value: 'auto-generated' },
    { name: 'Precedence', value: 'bulk' },
    { name: 'List-Unsubscribe', value: '<mailto:u@example.com>' },
    { name: 'List-Id', value: '<list.example.com>' },
    { name: 'Date', value: 'Mon, 1 Jan 2026 00:00:00 +0000' },
    { name: 'Subject', value: 'Hi' },
    { name: 'Cc', value: 'c@example.com' },
    { name: 'To', value: 't@example.com' },
    { name: 'Reply-To', value: 'r@example.com' },
    { name: 'Sender', value: 's@example.com' },
    { name: 'From', value: 'f@example.com' },
  ];

  function stateOf(headers: GmailHeader[], parts?: GmailMessagePart[]): Record<string, string> {
    const payload: GmailMessagePart = {
      ...plainPart('hello', headers),
      ...(parts === undefined ? {} : { parts }),
    };
    const [first] = buildState(thread(message('a', { payload })), deps);
    return { ...first };
  }

  it('orders keys by the map with body last', () => {
    const state = stateOf(all);
    expect(Object.keys(state)).toEqual([...STATE_HEADER_KEYS.map(([, key]) => key), 'body']);
    expect(JSON.stringify(state).indexOf('"body"')).toBeGreaterThan(
      JSON.stringify(state).indexOf('"autoSubmitted"'),
    );
  });

  it('matches names case-insensitively and trims values', () => {
    const state = stateOf([
      { name: 'SUBJECT', value: '  Hello \n' },
      { name: 'reply-to', value: ' r@example.com ' },
    ]);
    expect(state['subject']).toBe('Hello');
    expect(state['replyTo']).toBe('r@example.com');
  });

  it('omits blank headers', () => {
    const state = stateOf([
      { name: 'Cc', value: '   ' },
      { name: 'To', value: '' },
    ]);
    expect(Object.keys(state)).toEqual(['body']);
  });

  it('joins a repeated header with ", ", dropping blanks', () => {
    const state = stateOf([
      { name: 'To', value: 'a@example.com' },
      { name: 'to', value: ' ' },
      { name: 'To', value: 'b@example.com' },
    ]);
    expect(state['to']).toBe('a@example.com, b@example.com');
  });

  it('ignores headers outside the allowlist', () => {
    const state = stateOf([
      { name: 'Received', value: 'x' },
      { name: 'X-Foo', value: 'y' },
      { name: 'Message-ID', value: '<z>' },
      { name: 'Content-Type', value: 'text/plain' },
      { name: 'From', value: 'f@example.com' },
    ]);
    expect(Object.keys(state)).toEqual(['from', 'body']);
  });

  it("ignores a nested part's headers", () => {
    const state = stateOf(
      [{ name: 'Subject', value: 'outer' }],
      [{ mimeType: 'text/plain', headers: [{ name: 'From', value: 'inner@example.com' }] }],
    );
    expect(state['from']).toBeUndefined();
    expect(state['subject']).toBe('outer');
  });
});

describe('buildState: body', () => {
  it('has no body key for empty or whitespace-only text', () => {
    for (const text of ['', '  \n\t ']) {
      const [first] = buildState(thread(message('a', { payload: plainPart(text) })), deps);
      expect(first).toEqual({});
    }
  });

  it('keeps a message with no payload as {}', () => {
    const noPayload: GmailMessage = { id: 'a', threadId: 't', internalDate: '1' };
    const state = buildState(thread(noPayload, message('b', { internalDate: '2' })), deps);
    expect(state).toHaveLength(2);
    expect(state[1]).toEqual({});
  });
});
