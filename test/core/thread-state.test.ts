import { describe, expect, it } from 'vitest';

import { selectBodyConverter } from '../../src/core/body/body-converter.ts';
import type { GmailMessage, GmailThread } from '../../src/core/gmail-types.ts';
import { buildState } from '../../src/core/jev-state.ts';
import { threadToState } from '../../src/core/thread-state.ts';
import type { ThreadToStateOptions } from '../../src/core/thread-state.ts';
import {
  estimateStateTokens,
  estimateTokens,
  JEV_LIMIT_TOKENS,
  reservedTokensForQuestions,
} from '../../src/core/token-estimate.ts';
import { nodeDecodeUtf8 } from '../fakes/node-utf8.ts';
import plainUtf8 from '../fixtures/gmail/01-plain-utf8-7bit.json' with { type: 'json' };
import alternative from '../fixtures/gmail/03-alternative-utf8-base64.json' with { type: 'json' };
import largePlain from '../fixtures/gmail/11-large-plain.json' with { type: 'json' };

const options: ThreadToStateOptions = {
  plainTextMethod: 'basic',
  questions: ['Is this a newsletter?'],
};

/** UTF-8 bytes as Gmail returns them: signed. */
function bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text), (b) => (b > 127 ? b - 256 : b));
}

function message(id: string, body: string, overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id,
    threadId: 't',
    internalDate: id,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `sender${id}@example.com` },
        { name: 'Subject', value: `Message ${id}` },
      ],
      body: { data: bytes(body) },
    },
    ...overrides,
  };
}

function thread(...messages: GmailMessage[]): GmailThread {
  return { id: 't', messages };
}

// ASCII with no escapes, so the cut body fills the budget to the token.
const huge = thread(message('2', 'Newest words go here. '.repeat(5000)), message('1', 'Old.'));

describe('threadToState', () => {
  it.each<[string, GmailThread]>([
    ['01-plain-utf8-7bit', plainUtf8],
    ['03-alternative-utf8-base64', alternative],
  ])('%s: the same state as buildState, not truncated', (_, fixture) => {
    const deps = { converter: selectBodyConverter('basic'), decodeUtf8: nodeDecodeUtf8 };
    expect(threadToState(fixture, options, nodeDecodeUtf8)).toEqual({
      state: buildState(fixture, deps),
    });
  });

  it('11-large-plain: its 1 MB body is cut from the end', () => {
    const deps = { converter: selectBodyConverter('basic'), decodeUtf8: nodeDecodeUtf8 };
    const [built] = buildState(largePlain, deps);
    const result = threadToState(largePlain, options, nodeDecodeUtf8);
    const body = result.state[0]?.body ?? '';
    expect(built?.body?.startsWith(body)).toBe(true);
    expect(result.truncated).toEqual({
      messagesDropped: 0,
      bodiesDropped: 0,
      charsDropped: (built?.body?.length ?? 0) - body.length,
    });
    const reserved = reservedTokensForQuestions(options.questions);
    expect(estimateStateTokens(result.state) + reserved).toBeLessThanOrEqual(JEV_LIMIT_TOKENS);
  });

  it('truncates a huge thread and returns the stats', () => {
    const result = threadToState(huge, options, nodeDecodeUtf8);
    expect(result.state).toHaveLength(1);
    expect(result.state[0]?.subject).toBe('Message 2');
    expect(result.truncated).toMatchObject({ messagesDropped: 1, bodiesDropped: 0 });
    const reserved = reservedTokensForQuestions(options.questions);
    expect(estimateStateTokens(result.state) + reserved).toBe(JEV_LIMIT_TOKENS);
  });

  it('a thread with only DRAFT, SPAM and TRASH messages gives {state: []}', () => {
    const leftOut = thread(
      message('3', 'draft', { labelIds: ['DRAFT'] }),
      message('2', 'spam', { labelIds: ['SPAM'] }),
      message('1', 'trash', { labelIds: ['TRASH', 'INBOX'] }),
    );
    expect(threadToState(leftOut, options, nodeDecodeUtf8)).toEqual({ state: [] });
    expect(threadToState({ id: 'empty' }, options, nodeDecodeUtf8)).toEqual({ state: [] });
  });

  it('reserves room for the question with the largest estimate, not the longest', () => {
    const english = 'Is this message a newsletter?';
    const cjk = 'これはニュースレターですか？';
    expect(cjk.length).toBeLessThan(english.length);
    expect(estimateTokens(cjk)).toBeGreaterThan(estimateTokens(english));
    const result = threadToState(huge, { ...options, questions: [english, cjk] }, nodeDecodeUtf8);
    expect(estimateStateTokens(result.state)).toBe(
      JEV_LIMIT_TOKENS - (estimateTokens(cjk) + 10 + 300 + 1000),
    );
  });

  it('reserves for the combined limit when the questions add up', () => {
    const questions = Array<string>(8).fill('Q'.repeat(5000));
    const result = threadToState(huge, { ...options, questions }, nodeDecodeUtf8);
    const s = estimateStateTokens(result.state);
    // The 64k rule is the tighter one here, and it's met exactly.
    expect(s + 8 * 5000 + 300 + 8 * 10 + 2000).toBe(65536);
    expect(s + 5000 + 300 + 10 + 1000).toBeLessThan(32768);
  });

  it('with no questions, reserves only the overhead and the margin', () => {
    const result = threadToState(huge, { ...options, questions: [] }, nodeDecodeUtf8);
    expect(estimateStateTokens(result.state)).toBe(JEV_LIMIT_TOKENS - 1300);
  });
});
