/**
 * The error for a page token Gmail rejected inside one paging loop. The token
 * is seconds old there, so the rejection is invalid state (Engineering
 * Standards §5), not an outcome. Neither the message nor the fields hold the
 * search's `q`: it holds the user's `excludeQuery`.
 */
import { UnexpectedResponseError } from '../core/errors.ts';

export function rejectedPageTokenError(): UnexpectedResponseError {
  return new UnexpectedResponseError('Gmail searchThreadIds rejected a page token', {
    service: 'gmail',
    reason: 'searchThreadIds rejected a page token from the same search',
  });
}
