/**
 * Counts the Gmail calls of a run and their quota units, and stores the
 * daily tally (`state.gmailCalls`; Solution Design §7.3, §9; epic #13
 * decision 4). The codec and the day rollover are in `src/core/gmail-calls.ts`.
 *
 * Nothing here logs or catches: the caller does.
 */
import {
  type GmailCallTally,
  GMAIL_CALLS_KEY,
  GMAIL_UNIT_COST,
  decodeGmailCalls,
  encodeGmailCalls,
  gmailCallsForDay,
} from '../core/gmail-calls.ts';
import type { GmailPort } from '../ports/gmail-port.ts';
import type { StatePort } from '../ports/state-port.ts';

export type CountingGmail = {
  /** The same port, counting each call before it's made. */
  readonly gmail: GmailPort;
  /** Calls made through `gmail` so far. */
  calls(): number;
  /** Quota units of those calls, by `GMAIL_UNIT_COST`. */
  units(): number;
};

/**
 * Wraps `gmail` so each method counts one call and its units **before**
 * delegating: a call that returns a failure or throws may still have used
 * quota. Results and exceptions pass through unchanged.
 */
export function countGmailCalls(gmail: GmailPort): CountingGmail {
  let calls = 0;
  let units = 0;
  const count = (method: keyof GmailPort): void => {
    calls += 1;
    units += GMAIL_UNIT_COST[method];
  };
  const counting = {
    getProfile: () => {
      count('getProfile');
      return gmail.getProfile();
    },
    listHistory: (request) => {
      count('listHistory');
      return gmail.listHistory(request);
    },
    searchThreadIds: (request) => {
      count('searchThreadIds');
      return gmail.searchThreadIds(request);
    },
    getThread: (threadId, format) => {
      count('getThread');
      return gmail.getThread(threadId, format);
    },
    listLabels: () => {
      count('listLabels');
      return gmail.listLabels();
    },
    createLabel: (name) => {
      count('createLabel');
      return gmail.createLabel(name);
    },
    modifyThread: (threadId, change) => {
      count('modifyThread');
      return gmail.modifyThread(threadId, change);
    },
  } satisfies GmailPort;
  return { gmail: counting, calls: () => calls, units: () => units };
}

/**
 * Today's tally: the stored one if its day is `today`, else `{day: today,
 * count: 0}`. Writes nothing. Throws `StateError` if the stored value doesn't
 * decode, and never resets it.
 */
export function loadGmailCalls(state: StatePort, today: string): GmailCallTally {
  const raw = state.get(GMAIL_CALLS_KEY);
  return gmailCallsForDay(raw === undefined ? undefined : decodeGmailCalls(raw), today);
}

/** Writes `state.gmailCalls`. A `StateError` from the port propagates. */
export function saveGmailCalls(state: StatePort, tally: GmailCallTally): void {
  state.set(GMAIL_CALLS_KEY, encodeGmailCalls(tally));
}
