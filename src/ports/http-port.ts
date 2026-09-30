import type { Fail, Result } from '../core/result.ts';

/**
 * One HTTP request. It carries the `Authorization` header, so it is never
 * logged (Engineering Standards §6).
 */
export type HttpRequest = {
  readonly url: string;
  readonly method: 'get' | 'post';
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType?: string;
  readonly payload?: string;
};

/**
 * The outcome of one request.
 *
 * - `ok: true` for **any** HTTP status, 4xx and 5xx included: classifying
 *   the status is the caller's job (SD §8.5). Header names are **lower-case**
 *   (the adapter normalizes them), so the core reads `retry-after` and
 *   `x-typesafe-request-id` (SD §8.2, §8.5).
 * - `transport`: a network error or timeout; the adapter reports it for every
 *   request in the batch, since `fetchAll` can't say which failed.
 * - `scope`: `script.external_request` isn't granted (SD §9); also reported
 *   for every request in the batch.
 *
 * Redirects aren't followed, so the `Authorization` header never follows one
 * to another host: a 3xx is an `ok` result with its status.
 */
export type HttpResult = Result<
  { status: number; headers: Readonly<Record<string, string>>; body: string },
  Fail<'transport', { message: string }> | Fail<'scope', { message: string }>
>;

/**
 * `UrlFetchApp.fetchAll` (SD §5.2, §8.5). Owned by E5, which refines it.
 *
 * Expected failures are results. Anything the adapter doesn't recognize is
 * thrown as `UnexpectedResponseError` (`src/core/errors.ts`) and reaches the
 * per-thread or per-run boundary (SD §10.1).
 */
export interface HttpPort {
  /**
   * Sends every request concurrently and returns one result per request, in
   * the same order. An empty list returns an empty list. Retries happen in
   * rounds, in the caller (SD §8.5).
   */
  sendAll(requests: readonly HttpRequest[]): readonly HttpResult[];
}
