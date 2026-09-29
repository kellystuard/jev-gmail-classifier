/**
 * `GasGmailAdapter`: `GmailPort` over the Advanced Gmail Service (`Gmail.Users.*`)
 * (Solution Design §5.2, §9; ADR-0003). This is E3's reading half: `getProfile`
 * and `listHistory`. `searchThreadIds` and `getThread` are #70's, and the
 * label and move methods are E6's.
 *
 * Every call is on the user `me`. The adapter does no retries, sleeps or call
 * counting: the rate limit is E7's. Errors go through `toGmailFailure`: a
 * recognized failure is returned, and anything else is thrown as
 * `UnexpectedResponseError`.
 */
import type { GmailHistoryRecord } from '../../core/gmail-types.ts';
import { UnexpectedResponseError } from '../../core/errors.ts';
import { ok } from '../../core/result.ts';
import type { GmailPort, ListHistoryRequest } from '../../ports/gmail-port.ts';

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

/**
 * The part of the Advanced Gmail Service this file uses. There is no Apps
 * Script type package (epic decision 15), and `declare const` emits nothing,
 * so the bundle calls the real global. #70 adds `Threads.list` and `Threads.get`.
 */
declare const Gmail: {
  Users: {
    getProfile(userId: 'me'): GmailProfileResponse;
    History: {
      list(userId: 'me', options: GmailHistoryListOptions): GmailHistoryListResponse;
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

  searchThreadIds(): never {
    throw new Error('searchThreadIds is implemented in #70');
  }

  getThread(): never {
    throw new Error('getThread is implemented in #70');
  }

  listLabels(): never {
    throw new Error('listLabels is implemented in E6');
  }

  createLabel(): never {
    throw new Error('createLabel is implemented in E6');
  }

  modifyThread(): never {
    throw new Error('modifyThread is implemented in E6');
  }

  trashThread(): never {
    throw new Error('trashThread is implemented in E6');
  }
}

/** A 200 whose shape the adapter can't use: invalid state, so exceptional. */
function malformed(reason: string, method: string): UnexpectedResponseError {
  return new UnexpectedResponseError(`Gmail ${method} returned an unusable response`, {
    service: 'gmail',
    reason,
  });
}
