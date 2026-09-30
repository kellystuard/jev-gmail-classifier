/**
 * `GasGmailAdapter`: `GmailPort` over the Advanced Gmail Service (`Gmail.Users.*`)
 * (Solution Design §5.2, §9; ADR-0003). E3's reading half: `getProfile`,
 * `listHistory`, `searchThreadIds` and `getThread`. E6's labels and moves:
 * `listLabels`, `createLabel` and `modifyThread` (spikes 25 and 26). A trash is
 * `modifyThread` adding `TRASH`, so there is no `threads.trash` call.
 *
 * Every call is on the user `me`. The adapter does no retries, sleeps, logging
 * or call counting: the rate limit is E7's. It compares no label names and
 * creates no parent labels: that is the label cache's (SD §6.5). Errors go
 * through `toGmailFailure`: a recognized failure is returned, and anything
 * else is thrown as `UnexpectedResponseError`.
 */
import type { GmailHistoryRecord, GmailLabel, GmailThread } from '../../core/gmail-types.ts';
import { UnexpectedResponseError } from '../../core/errors.ts';
import { ok } from '../../core/result.ts';
import type {
  GetThreadFormat,
  GmailPort,
  ListHistoryRequest,
  SearchThreadIdsRequest,
  ThreadLabelChange,
} from '../../ports/gmail-port.ts';

import { toGmailFailure } from './gmail-errors.ts';

/** `Users.getProfile`'s response, the fields this adapter reads. */
type GmailProfileResponse = {
  readonly emailAddress?: string;
  readonly historyId?: string;
};

/** `Users.History.list`'s options: only what the request sets. */
type GmailHistoryListOptions = {
  readonly startHistoryId: string;
  readonly historyTypes: readonly string[];
  readonly pageToken?: string;
  readonly maxResults?: number;
};

/** `Users.History.list`'s response. Gmail leaves `history` out when there are no records. */
type GmailHistoryListResponse = {
  readonly history?: readonly GmailHistoryRecord[];
  readonly historyId?: string;
  readonly nextPageToken?: string;
};

/** `Users.Threads.list`'s options: `q` and `includeSpamTrash` always, the rest only when set. */
type GmailThreadsListOptions = {
  readonly q: string;
  readonly includeSpamTrash: boolean;
  readonly pageToken?: string;
  readonly maxResults?: number;
};

/** `Users.Threads.list`'s response. Gmail leaves `threads` out when nothing matches. */
type GmailThreadsListResponse = {
  readonly threads?: readonly { readonly id?: string }[];
  readonly nextPageToken?: string;
};

/** `Users.Threads.get`'s options. `metadataHeaders` goes with `format: 'metadata'` only. */
type GmailThreadsGetOptions =
  | { readonly format: 'full' | 'minimal' }
  | { readonly format: 'metadata'; readonly metadataHeaders: string[] };

/** `Users.Labels.list`'s response. The entries are checked before use. */
type GmailLabelsListResponse = { readonly labels?: unknown };

/** `Users.Labels.create`'s resource: what spike 25 sent. */
type GmailLabelCreateResource = {
  readonly name: string;
  readonly labelListVisibility: 'labelShow';
  readonly messageListVisibility: 'show';
};

/** `Users.Labels.create`'s response, the fields this adapter reads. */
type GmailLabelCreateResponse = { readonly id?: unknown; readonly name?: unknown };

/** `Users.Threads.modify`'s resource. */
type GmailThreadsModifyResource = {
  readonly addLabelIds: string[];
  readonly removeLabelIds: string[];
};

/**
 * The part of the Advanced Gmail Service this file uses. There is no Apps
 * Script type package (epic decision 15), and `declare const` emits nothing,
 * so the bundle calls the real global. The write calls take the resource
 * first, then the user (spike 27).
 */
declare const Gmail: {
  Users: {
    getProfile(userId: 'me'): GmailProfileResponse;
    History: {
      list(userId: 'me', options: GmailHistoryListOptions): GmailHistoryListResponse;
    };
    Labels: {
      list(userId: 'me'): GmailLabelsListResponse;
      create(resource: GmailLabelCreateResource, userId: 'me'): GmailLabelCreateResponse;
    };
    Threads: {
      list(userId: 'me', options: GmailThreadsListOptions): GmailThreadsListResponse;
      get(userId: 'me', threadId: string, options: GmailThreadsGetOptions): GmailThread;
      modify(resource: GmailThreadsModifyResource, userId: 'me', threadId: string): unknown;
    };
  };
};

const DIGITS = /^\d+$/;

export class GasGmailAdapter implements GmailPort {
  getProfile(): ReturnType<GmailPort['getProfile']> {
    let response: GmailProfileResponse;
    try {
      response = Gmail.Users.getProfile('me');
    } catch (error) {
      return toGmailFailure(error, { method: 'getProfile' });
    }
    const { emailAddress, historyId } = response;
    if (
      typeof emailAddress !== 'string' ||
      emailAddress === '' ||
      typeof historyId !== 'string' ||
      historyId === ''
    ) {
      throw malformed('getProfile response is malformed', 'getProfile');
    }
    return ok({ emailAddress, historyId });
  }

  listHistory(request: ListHistoryRequest): ReturnType<GmailPort['listHistory']> {
    // Only set what the request sets: never an `undefined` value.
    const options: GmailHistoryListOptions = {
      startHistoryId: request.startHistoryId,
      historyTypes: [...request.historyTypes],
      ...(request.pageToken === undefined ? {} : { pageToken: request.pageToken }),
      ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
    };
    let response: GmailHistoryListResponse;
    try {
      response = Gmail.Users.History.list('me', options);
    } catch (error) {
      // A 404 is an expired position, or one ahead of the mailbox (spike 62).
      return toGmailFailure(error, { method: 'listHistory', notFound: 'history_expired' });
    }
    const { history, historyId, nextPageToken } = response;
    if (typeof historyId !== 'string' || !DIGITS.test(historyId)) {
      throw malformed('history.list response is malformed', 'listHistory');
    }
    if (history !== undefined && !Array.isArray(history)) {
      throw malformed('history.list response is malformed', 'listHistory');
    }
    return ok({
      records: history ?? [],
      historyId,
      ...(typeof nextPageToken === 'string' && nextPageToken !== '' ? { nextPageToken } : {}),
    });
  }

  searchThreadIds(request: SearchThreadIdsRequest): ReturnType<GmailPort['searchThreadIds']> {
    // One page per call: the caller pages. Only set what the request sets.
    const options: GmailThreadsListOptions = {
      q: request.q,
      includeSpamTrash: request.includeSpamTrash,
      ...(request.pageToken === undefined ? {} : { pageToken: request.pageToken }),
      ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
    };
    let response: GmailThreadsListResponse;
    try {
      response = Gmail.Users.Threads.list('me', options);
    } catch (error) {
      // No `notFound`: a 404 has no expected meaning for a search. The error
      // never carries `q`, which holds the user's `excludeQuery`.
      return toGmailFailure(error, { method: 'searchThreadIds' });
    }
    const { nextPageToken } = response;
    const threads: unknown = response.threads;
    if (threads !== undefined && !Array.isArray(threads)) {
      throw malformed('threads.list response is malformed', 'searchThreadIds');
    }
    const entries: readonly unknown[] = threads ?? [];
    const threadIds = entries.map((entry) => {
      const id =
        typeof entry === 'object' && entry !== null && 'id' in entry ? entry.id : undefined;
      if (typeof id !== 'string' || id === '') {
        throw malformed('threads.list response is malformed', 'searchThreadIds');
      }
      return id;
    });
    return ok({
      threadIds,
      ...(typeof nextPageToken === 'string' && nextPageToken !== '' ? { nextPageToken } : {}),
    });
  }

  getThread(threadId: string, format: GetThreadFormat): ReturnType<GmailPort['getThread']> {
    const options: GmailThreadsGetOptions =
      format.format === 'metadata'
        ? { format: 'metadata', metadataHeaders: [...format.metadataHeaders] }
        : { format: format.format };
    let thread: GmailThread;
    try {
      thread = Gmail.Users.Threads.get('me', threadId, options);
    } catch (error) {
      // A 404 is a thread deleted since it was queued.
      return toGmailFailure(error, { method: 'getThread', notFound: 'not_found' });
    }
    if (typeof thread !== 'object' || typeof thread.id !== 'string') {
      throw malformed('threads.get response is malformed', 'getThread');
    }
    // Gmail's object is passed through: `internalDate` stays a string and
    // `body.data` stays the signed byte array (spike 29).
    return ok({ thread });
  }

  listLabels(): ReturnType<GmailPort['listLabels']> {
    let response: GmailLabelsListResponse;
    try {
      // One response, with no paging (spike 25 row 11).
      response = Gmail.Users.Labels.list('me');
    } catch (error) {
      return toGmailFailure(error, { method: 'listLabels' });
    }
    // Every mailbox has system labels, so an absent list is unusable.
    const entries: unknown = response.labels;
    if (!Array.isArray(entries)) {
      throw malformed('labels.list response is malformed', 'listLabels');
    }
    const list: readonly unknown[] = entries;
    const labels = list.map((entry): GmailLabel => {
      if (typeof entry !== 'object' || entry === null) {
        throw malformed('labels.list response is malformed', 'listLabels');
      }
      const id = 'id' in entry ? entry.id : undefined;
      const name = 'name' in entry ? entry.name : undefined;
      const type = 'type' in entry ? entry.type : undefined;
      if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '') {
        throw malformed('labels.list response is malformed', 'listLabels');
      }
      return { id, name, ...(typeof type === 'string' ? { type } : {}) };
    });
    return ok({ labels });
  }

  createLabel(name: string): ReturnType<GmailPort['createLabel']> {
    let response: GmailLabelCreateResponse;
    try {
      // Exactly the leaf: Gmail creates no parents (spike 25).
      response = Gmail.Users.Labels.create(
        { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
        'me',
      );
    } catch (error) {
      return toGmailFailure(error, {
        method: 'createLabel',
        expected: ['label_exists', 'invalid_label_name'],
      });
    }
    const { id, name: createdName } = response;
    if (
      typeof id !== 'string' ||
      id === '' ||
      typeof createdName !== 'string' ||
      createdName === ''
    ) {
      throw malformed('labels.create response is malformed', 'createLabel');
    }
    // `labels.create` returns no `type`.
    return ok({ label: { id, name: createdName } });
  }

  modifyThread(threadId: string, change: ThreadLabelChange): ReturnType<GmailPort['modifyThread']> {
    try {
      // The response body isn't read: success is all the caller needs.
      Gmail.Users.Threads.modify(
        { addLabelIds: [...change.addLabelIds], removeLabelIds: [...change.removeLabelIds] },
        'me',
        threadId,
      );
    } catch (error) {
      // A 404 is a thread deleted since it was read.
      return toGmailFailure(error, {
        method: 'modifyThread',
        notFound: 'not_found',
        expected: ['invalid_label', 'failed_precondition'],
      });
    }
    return ok({});
  }
}

/** A 200 whose shape the adapter can't use: invalid state, so exceptional. */
function malformed(reason: string, method: string): UnexpectedResponseError {
  return new UnexpectedResponseError(`Gmail ${method} returned an unusable response`, {
    service: 'gmail',
    reason,
  });
}
