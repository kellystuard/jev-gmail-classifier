import { describe, expect, it } from 'vitest';

import type { GmailMessagePart, GmailThread } from '../../src/core/gmail-types.ts';
import plainUtf8 from '../fixtures/gmail/01-plain-utf8-7bit.json' with { type: 'json' };
import mixedAttachments from '../fixtures/gmail/04-mixed-attachments.json' with { type: 'json' };
import forwardAsAttachment from '../fixtures/gmail/14-forward-as-attachment.json' with { type: 'json' };

// These assignments are the real check: `npm run typecheck` fails if the types
// drift from what the Advanced Gmail Service returns.
const fixtures: readonly [string, GmailThread][] = [
  ['01-plain-utf8-7bit', plainUtf8],
  ['04-mixed-attachments', mixedAttachments],
  ['14-forward-as-attachment', forwardAsAttachment],
];

function allParts(part: GmailMessagePart | undefined): GmailMessagePart[] {
  if (part === undefined) {
    return [];
  }
  return [part, ...(part.parts ?? []).flatMap(allParts)];
}

describe.each(fixtures)('fixture %s', (_name, thread) => {
  it('has messages in the thread', () => {
    expect(thread.messages?.length).toBeGreaterThan(0);
    for (const message of thread.messages ?? []) {
      expect(message.threadId).toBe(thread.id);
    }
  });

  it('carries body data as signed bytes, never a string', () => {
    const parts = (thread.messages ?? []).flatMap((m) => allParts(m.payload));
    const data = parts.flatMap((p) => (p.body?.data === undefined ? [] : [p.body.data]));
    expect(data.length).toBeGreaterThan(0);
    for (const bytes of data) {
      expect(bytes.every((b) => Number.isInteger(b) && b >= -128 && b <= 127)).toBe(true);
    }
  });
});
