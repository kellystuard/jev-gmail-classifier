/**
 * `GasHttpAdapter`: `HttpPort` over `UrlFetchApp.fetchAll` (Solution Design
 * §5.2, §8.5; epic #11 decision 11; spike #94).
 *
 * - **One `fetchAll` per `sendAll`**, so the requests run concurrently. An
 *   empty list returns `[]` without calling it.
 * - **Every status is `ok`**: `muteHttpExceptions: true` makes a 4xx or 5xx a
 *   response, and classifying it is the caller's job. Header names are
 *   lower-cased (`normalizeHeaders`), and the body is read as UTF-8 (Jev's
 *   bodies are JSON).
 * - **Redirects aren't followed** (`followRedirects: false`), so the
 *   `Authorization` header never follows one to another host: a 3xx comes back
 *   as its status.
 * - **A thrown `fetchAll`** (a DNS error, a timeout, or a missing
 *   `script.external_request` scope) fails the whole batch: `fetchAll` can't
 *   say which request failed (spike #94), so every request gets the same
 *   `transport` (or `scope`) result. This catch is the per-request error
 *   boundary (SD §10.1).
 *
 * The adapter doesn't log. No header or payload ever reaches a failure's
 * `message`: it is the exception's own text (`batchFailure`).
 */
import type { HttpPort, HttpRequest, HttpResult } from '../../ports/http-port.ts';
import { ok } from '../../core/result.ts';
import { batchFailure, normalizeHeaders } from './http-results.ts';

/** The `UrlFetchApp.fetchAll` request options this file sets. */
type FetchAllRequest = {
  url: string;
  method: 'get' | 'post';
  headers: Record<string, string>;
  muteHttpExceptions: true;
  followRedirects: false;
  contentType?: string;
  payload?: string;
};

/** `HTTPResponse`, the methods this file uses. */
interface HttpResponse {
  getResponseCode(): number;
  getAllHeaders(): Record<string, unknown>;
  getContentText(charset: string): string;
}

/**
 * There is no Apps Script type package (epic decision 15), and `declare const`
 * emits nothing: the global is Apps Script's.
 */
declare const UrlFetchApp: {
  fetchAll(requests: FetchAllRequest[]): HttpResponse[];
};

export class GasHttpAdapter implements HttpPort {
  sendAll(requests: readonly HttpRequest[]): readonly HttpResult[] {
    if (requests.length === 0) {
      return [];
    }
    let responses: HttpResponse[];
    try {
      responses = UrlFetchApp.fetchAll(requests.map(toFetchAllRequest));
    } catch (error) {
      return batchFailure(error, requests.length);
    }
    return responses.map((response) =>
      ok({
        status: response.getResponseCode(),
        headers: normalizeHeaders(response.getAllHeaders()),
        body: response.getContentText('UTF-8'),
      }),
    );
  }
}

/**
 * The `fetchAll` options for one request. `Content-Type` goes in
 * `contentType`, never in `headers` (UrlFetchApp rejects it there).
 */
function toFetchAllRequest(request: HttpRequest): FetchAllRequest {
  return {
    url: request.url,
    method: request.method,
    headers: { ...request.headers },
    muteHttpExceptions: true,
    followRedirects: false,
    ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
    ...(request.payload === undefined ? {} : { payload: request.payload }),
  };
}
