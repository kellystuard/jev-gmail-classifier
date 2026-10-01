import type {
  GmailHeader,
  GmailHistoryRecord,
  GmailLabel,
  GmailLabelChange,
  GmailMessage,
  GmailMessagePart,
  GmailMessageRef,
  GmailThread,
} from '../../src/core/gmail-types.ts';
import { type Fail, type NoFields, type Result, fail, ok } from '../../src/core/result.ts';
import type {
  GetThreadFormat,
  GmailFailure,
  GmailPort,
  ListHistoryRequest,
  SearchThreadIdsRequest,
  ThreadLabelChange,
} from '../../src/ports/gmail-port.ts';
import type { FakeClock } from './fake-clock.ts';
import { FakeScopes } from './fake-scopes.ts';
import { type FailNextOptions, type FakeCall, FailureQueue } from './failure-queue.ts';

export type GmailMethod = keyof GmailPort;

/** The failures `method` can return, for `failNext`. */
export type GmailFailureOf<M extends GmailMethod> = Extract<
  ReturnType<GmailPort[M]>,
  { ok: false }
>;

type AnyGmailFailure = GmailFailureOf<GmailMethod>;

/** Quota units per call (Solution Design §9; `labels.create` from Gmail's quota table). */
export const GMAIL_UNIT_COSTS: Readonly<Record<GmailMethod, number>> = {
  getProfile: 1,
  listLabels: 1,
  listHistory: 2,
  searchThreadIds: 10,
  modifyThread: 10,
  getThread: 40,
  createLabel: 5,
};

/** The message Gmail returns for a rejected page token (spike 287). */
const INVALID_PAGE_TOKEN_MESSAGE =
  'API call to gmail.users.threads.list failed with error: Invalid pageToken';

/** The message Gmail returns for the per-user rate limit (SD §9, spike 30). */
export const RATE_LIMIT_MESSAGE =
  "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'";

export const SYSTEM_LABEL_IDS = [
  'INBOX',
  'SPAM',
  'TRASH',
  'SENT',
  'DRAFT',
  'UNREAD',
  'IMPORTANT',
  'STARRED',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
] as const;

/** Names `labels.create` rejects with 400 "Invalid label name", compared in lower case (spike 25). */
const RESERVED_LABEL_NAMES = new Set([
  'inbox',
  'spam',
  'trash',
  'sent',
  'drafts',
  'starred',
  'important',
  'unread',
  'chats',
]);

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

export type FakeGmailOptions = {
  readonly scopes?: FakeScopes;
  /** Used for `deliver`'s default `internalDate` and for latency. */
  readonly clock?: FakeClock;
  /** Added to the clock on every call. */
  readonly latencyMs?: number;
  /** Default `owner@example.com`. */
  readonly emailAddress?: string;
  /** The mailbox's starting `historyId`. Default 1000. */
  readonly historyId?: number;
  /** Write a bare record (only `id` and `messages`) after each change record, as Gmail does. Default true. */
  readonly bareRecords?: boolean;
  /** Page size for `listHistory` and `searchThreadIds` when the request has no `maxResults`. Default 2. */
  readonly pageSize?: number;
  /**
   * The most IDs one `searchThreadIds` page holds, whatever `maxResults` asks
   * for. It models Gmail returning fewer results than `maxResults`, which it's
   * allowed to do, so a paging test doesn't need more than 500 threads. Unset,
   * a page holds `maxResults ?? pageSize`. `maxPageSize` caps both methods.
   */
  readonly maxSearchPageSize?: number;
  /**
   * The most items one `listHistory` or `searchThreadIds` page holds, whatever
   * `maxResults` asks for, as Gmail may return fewer than `maxResults`. Ingest
   * always asks for 100, so a paging test sets this low. Unset: no limit.
   */
  readonly maxPageSize?: number;
};

export type DeliverOptions = {
  /** Add to this existing thread. A new thread when unset. */
  readonly threadId?: string;
  /** The new message's own labels. Default `INBOX`, `UNREAD`. */
  readonly labelIds?: readonly string[];
  /** Epoch ms. Default the clock's time. */
  readonly internalDate?: number;
  readonly headers?: readonly GmailHeader[];
  readonly bodyText?: string;
};

type StoredMessage = {
  readonly id: string;
  readonly threadId: string;
  labelIds: string[];
  readonly internalDate: string;
  historyId: string;
  readonly sizeEstimate: number | undefined;
  readonly snippet: string | undefined;
  readonly payload: GmailMessagePart | undefined;
};

/**
 * The Advanced Gmail Service, with a small mailbox and a history log that
 * behave the way E1 observed (spikes 19, 20, 23, 25, 26, 29, 30):
 *
 * - history records with the labels at the time of the change, bare records
 *   with no change array, pages whose `historyId` moves, and expiry (a start
 *   before `expireHistoryBefore`, or ahead of the mailbox's `historyId`);
 * - search through a test-supplied matcher that misses Spam and Trash unless
 *   `includeSpamTrash` is set;
 * - label creation without parents, with case-insensitive conflicts and
 *   reserved names;
 * - `threads.modify` side effects (`SPAM`/`TRASH` remove `INBOX`, repeats
 *   write nothing) with only label records, never `messagesAdded`;
 * - quota units, latency, `scope` while `gmail.modify` is revoked, and
 *   injected failures.
 */
export class FakeGmail implements GmailPort {
  readonly calls: FakeCall<GmailMethod>[] = [];
  /** Every `q` passed to `searchThreadIds`, in order. */
  readonly searches: string[] = [];
  /** Quota units used so far. */
  unitsUsed = 0;
  /** Called at the start of every call, before any failure or effect. Lets a test change the mailbox mid-sequence. */
  onCall: ((method: GmailMethod, args: readonly unknown[]) => void) | undefined = undefined;

  private readonly scopes: FakeScopes;
  private readonly clock: FakeClock | undefined;
  private readonly latencyMs: number;
  private readonly emailAddress: string;
  private readonly bareRecords: boolean;
  private searchGeneration = 0;
  private readonly pageSize: number;
  private readonly maxSearchPageSize: number;
  private readonly maxPageSize: number;
  private readonly failures = new FailureQueue<GmailMethod, AnyGmailFailure>();

  private currentHistoryId: number;
  private expiredBefore = 0;
  private readonly records: GmailHistoryRecord[] = [];
  private readonly messages = new Map<string, StoredMessage>();
  private readonly threads = new Map<string, string[]>();
  private readonly labels = new Map<string, GmailLabel>();
  private nextLabelNumber = 1;
  private nextMessageNumber = 1;
  private nextThreadNumber = 1;
  private searchMatcher: ((q: string, message: GmailMessage) => boolean) | undefined = undefined;

  constructor(options: FakeGmailOptions = {}) {
    this.scopes = options.scopes ?? new FakeScopes();
    this.clock = options.clock;
    this.latencyMs = options.latencyMs ?? 0;
    this.emailAddress = options.emailAddress ?? 'owner@example.com';
    this.currentHistoryId = options.historyId ?? 1000;
    this.bareRecords = options.bareRecords ?? true;
    this.pageSize = options.pageSize ?? 2;
    this.maxSearchPageSize = options.maxSearchPageSize ?? Infinity;
    this.maxPageSize = options.maxPageSize ?? Infinity;
    for (const id of SYSTEM_LABEL_IDS) {
      this.labels.set(id, { id, name: id, type: 'system' });
    }
  }

  // ---- GmailPort ----

  getProfile(): Result<{ emailAddress: string; historyId: string }, GmailFailure> {
    const failure = this.begin('getProfile', []);
    if (failure !== undefined) {
      return failure;
    }
    return ok({ emailAddress: this.emailAddress, historyId: String(this.currentHistoryId) });
  }

  listHistory(
    request: ListHistoryRequest,
  ): Result<
    { records: readonly GmailHistoryRecord[]; historyId: string; nextPageToken?: string },
    GmailFailure | Fail<'history_expired'>
  > {
    const failure = this.begin('listHistory', [request]);
    if (failure !== undefined) {
      return failure;
    }
    const start = Number(request.startHistoryId);
    if (!Number.isInteger(start)) {
      throw new Error(
        `FakeGmail.listHistory: startHistoryId "${request.startHistoryId}" isn't a number`,
      );
    }
    // Gmail answers 404 both for a discarded position and for one ahead of
    // the mailbox (spike 62, finding 3; E1 #21, E5).
    if (start < this.expiredBefore || start > this.currentHistoryId) {
      return fail('history_expired');
    }
    const after =
      request.pageToken === undefined ? start : decodeToken('history', request.pageToken);
    const types = new Set(request.historyTypes);
    const matching = this.records.filter(
      (r) =>
        Number(r.id) > after &&
        ((r.messagesAdded !== undefined && types.has('messageAdded')) ||
          (r.labelsRemoved !== undefined && types.has('labelRemoved')) ||
          (r.messagesAdded === undefined &&
            r.labelsRemoved === undefined &&
            r.labelsAdded === undefined)),
    );
    const page = matching.slice(0, Math.min(request.maxResults ?? this.pageSize, this.maxPageSize));
    const last = page[page.length - 1];
    const historyId = String(this.currentHistoryId);
    if (last !== undefined && matching.length > page.length) {
      return ok({
        records: clone(page),
        historyId,
        nextPageToken: encodeToken('history', Number(last.id)),
      });
    }
    return ok({ records: clone(page), historyId });
  }

  searchThreadIds(
    request: SearchThreadIdsRequest,
  ): Result<
    { threadIds: readonly string[]; nextPageToken?: string },
    GmailFailure | Fail<'invalid_page_token', { message: string }>
  > {
    const failure = this.begin('searchThreadIds', [request]);
    if (failure !== undefined) {
      return failure;
    }
    this.searches.push(request.q);
    const matcher = this.searchMatcher;
    if (matcher === undefined) {
      throw new Error('FakeGmail.searchThreadIds: call setSearchMatcher first');
    }
    const threadIds: string[] = [];
    for (const [threadId, messageIds] of this.threads) {
      const hit = messageIds.some((id) => {
        const message = this.message(id);
        if (
          !request.includeSpamTrash &&
          (message.labelIds.includes('SPAM') || message.labelIds.includes('TRASH'))
        ) {
          return false;
        }
        return matcher(request.q, this.toFull(message));
      });
      if (hit) {
        threadIds.push(threadId);
      }
    }
    let offset = 0;
    if (request.pageToken !== undefined) {
      const decoded = decodeSearchToken(request.pageToken, this.searchGeneration);
      if (decoded === undefined) {
        return FakeGmail.invalidPageToken();
      }
      offset = decoded;
    }
    const size = Math.min(
      request.maxResults ?? this.pageSize,
      this.maxSearchPageSize,
      this.maxPageSize,
    );
    const page = threadIds.slice(offset, offset + size);
    if (offset + size < threadIds.length) {
      return ok({
        threadIds: page,
        nextPageToken: encodeSearchToken(this.searchGeneration, offset + size),
      });
    }
    return ok({ threadIds: page });
  }

  getThread(
    threadId: string,
    format: GetThreadFormat,
  ): Result<{ thread: GmailThread }, GmailFailure | Fail<'not_found'>> {
    const failure = this.begin('getThread', [threadId, format], threadId);
    if (failure !== undefined) {
      return failure;
    }
    const messageIds = this.threads.get(threadId);
    if (messageIds === undefined) {
      return fail('not_found');
    }
    const stored = messageIds.map((id) => this.message(id));
    const messages = stored.map((m) => {
      switch (format.format) {
        case 'full':
          return this.toFull(m);
        case 'metadata':
          return toMetadata(m, format.metadataHeaders);
        case 'minimal':
          return toMinimal(m);
      }
    });
    const historyId = String(Math.max(...stored.map((m) => Number(m.historyId))));
    return ok({ thread: { id: threadId, historyId, messages } });
  }

  listLabels(): Result<{ labels: readonly GmailLabel[] }, GmailFailure> {
    const failure = this.begin('listLabels', []);
    if (failure !== undefined) {
      return failure;
    }
    return ok({ labels: [...this.labels.values()].map((l) => ({ ...l })) });
  }

  createLabel(
    name: string,
  ): Result<
    { label: GmailLabel },
    | GmailFailure
    | Fail<'label_exists', { message: string }>
    | Fail<'invalid_label_name', { message: string }>
  > {
    const failure = this.begin('createLabel', [name]);
    if (failure !== undefined) {
      return failure;
    }
    if (RESERVED_LABEL_NAMES.has(name.trim().toLowerCase())) {
      return fail('invalid_label_name', { message: 'Invalid label name' });
    }
    const key = labelKey(name);
    for (const label of this.labels.values()) {
      if (labelKey(label.name) === key) {
        return fail('label_exists', { message: 'Label name exists or conflicts' });
      }
    }
    const label = this.addUserLabel(name);
    return ok({ label: { ...label } });
  }

  modifyThread(
    threadId: string,
    change: ThreadLabelChange,
  ): Result<
    NoFields,
    | GmailFailure
    | Fail<'not_found'>
    | Fail<'invalid_label', { message: string }>
    | Fail<'failed_precondition', { message: string }>
  > {
    const failure = this.begin('modifyThread', [threadId, change], threadId);
    if (failure !== undefined) {
      return failure;
    }
    return this.applyChange(threadId, change.addLabelIds, change.removeLabelIds);
  }

  // ---- Test helpers ----

  /**
   * Makes the next call(s) to `method` fail with `failure`, or throw it if
   * it's an `Error` (an unrecognized failure). `threadId` limits it to calls
   * for that thread.
   */
  failNext<M extends GmailMethod>(
    method: M,
    failure: GmailFailureOf<M> | Error,
    options: FailNextOptions = {},
  ): void {
    this.failures.add(method, failure, options, options.threadId);
  }

  /** The `rate_limited` failure Gmail returns for the per-user limit. */
  static rateLimited(): Fail<'rate_limited', { message: string }> {
    return fail('rate_limited', { message: RATE_LIMIT_MESSAGE });
  }

  /** The failure Gmail returns for a rejected `threads.list` page token (spike 287). */
  static invalidPageToken(): Fail<'invalid_page_token', { message: string }> {
    return fail('invalid_page_token', { message: INVALID_PAGE_TOKEN_MESSAGE });
  }

  /**
   * Every search page token issued so far is rejected from now on, as if it
   * hadn't survived until a later execution. Tokens issued afterwards work.
   */
  invalidateSearchTokens(): void {
    this.searchGeneration += 1;
  }

  /** The transient `failed_precondition` E1 saw on a freshly imported thread (spike 26). */
  static failedPrecondition(): Fail<'failed_precondition', { message: string }> {
    return fail('failed_precondition', { message: 'Precondition check failed.' });
  }

  /**
   * Seeds a thread as it already is, with no history records: for example a
   * file from `test/fixtures/gmail/`. Part `data` stays a byte array.
   */
  addThread(thread: GmailThread): void {
    if (this.threads.has(thread.id)) {
      throw new Error(`FakeGmail.addThread: thread ${thread.id} already exists`);
    }
    const ids: string[] = [];
    for (const message of thread.messages ?? []) {
      if (message.threadId !== thread.id) {
        throw new Error(
          `FakeGmail.addThread: message ${message.id} has threadId ${message.threadId}`,
        );
      }
      if (this.messages.has(message.id)) {
        throw new Error(`FakeGmail.addThread: message ${message.id} already exists`);
      }
      this.messages.set(message.id, {
        id: message.id,
        threadId: thread.id,
        labelIds: [...(message.labelIds ?? [])],
        internalDate: message.internalDate ?? String(this.now()),
        historyId: String(this.currentHistoryId),
        sizeEstimate: message.sizeEstimate,
        snippet: message.snippet,
        payload: message.payload === undefined ? undefined : clone(message.payload),
      });
      ids.push(message.id);
    }
    this.threads.set(thread.id, ids);
  }

  /**
   * Adds a new message and writes a `messageAdded` record. The message has
   * only its own labels: it doesn't inherit the thread's labels, `SPAM` or
   * `TRASH` (spikes 20 and 26).
   */
  deliver(options: DeliverOptions = {}): { id: string; threadId: string } {
    const threadId = options.threadId ?? `thread-${String(this.nextThreadNumber++)}`;
    const thread = this.threads.get(threadId);
    if (options.threadId !== undefined && thread === undefined) {
      throw new Error(`FakeGmail.deliver: unknown thread ${threadId}`);
    }
    const id = `msg-${String(this.nextMessageNumber++)}`;
    const labelIds = [...(options.labelIds ?? ['INBOX', 'UNREAD'])];
    const bytes = [...new Int8Array(Buffer.from(options.bodyText ?? '', 'utf8'))];
    const historyId = this.nextHistoryId();
    this.messages.set(id, {
      id,
      threadId,
      labelIds,
      internalDate: String(options.internalDate ?? this.now()),
      historyId,
      sizeEstimate: bytes.length,
      snippet: (options.bodyText ?? '').slice(0, 100),
      payload: {
        partId: '',
        mimeType: 'text/plain',
        filename: '',
        headers: [...(options.headers ?? [])],
        body: { size: bytes.length, data: bytes },
      },
    });
    if (thread === undefined) {
      this.threads.set(threadId, [id]);
    } else {
      thread.push(id);
    }
    this.writeRecord(historyId, [{ id, threadId }], {
      messagesAdded: [{ message: { id, threadId, labelIds: [...labelIds] } }],
    });
    return { id, threadId };
  }

  /**
   * The user removes a label from a thread in the Gmail UI: one record, with
   * one `labelsRemoved` entry per message that had it (spike 20).
   */
  removeLabelAsUser(threadId: string, labelId: string): void {
    const messageIds = this.threads.get(threadId);
    if (messageIds === undefined) {
      throw new Error(`FakeGmail.removeLabelAsUser: unknown thread ${threadId}`);
    }
    this.removeFromMessages(
      messageIds.map((id) => this.message(id)),
      labelId,
    );
  }

  /**
   * The user deletes a label: one record per thread that had it, then the
   * label is gone, so creating the name again gives a new ID (spike 20,
   * finding 8).
   */
  deleteLabelAsUser(labelId: string): void {
    const label = this.labels.get(labelId);
    if (label === undefined || label.type === 'system') {
      throw new Error(`FakeGmail.deleteLabelAsUser: ${labelId} isn't a user label`);
    }
    for (const messageIds of this.threads.values()) {
      this.removeFromMessages(
        messageIds.map((id) => this.message(id)),
        labelId,
      );
    }
    this.labels.delete(labelId);
  }

  /** Adds a user label directly, with no quota or history, and returns it. */
  seedLabel(name: string): GmailLabel {
    return { ...this.addUserLabel(name) };
  }

  /** From now on, `listHistory` with a `startHistoryId` below `historyId` returns `history_expired`. */
  expireHistoryBefore(historyId: string | number): void {
    this.expiredBefore = Number(historyId);
  }

  /** Supplies the search engine: whether `message` matches `q`. The fake never parses Gmail queries. */
  setSearchMatcher(matcher: (q: string, message: GmailMessage) => boolean): void {
    this.searchMatcher = matcher;
  }

  /** The mailbox's current `historyId`. */
  get historyId(): string {
    return String(this.currentHistoryId);
  }

  /** Every history record written so far, bare ones included. */
  get history(): readonly GmailHistoryRecord[] {
    return clone(this.records);
  }

  /** A message's current labels. */
  labelsOf(messageId: string): readonly string[] {
    return [...this.message(messageId).labelIds];
  }

  /** The labels on each message of a thread, in order. */
  threadLabels(threadId: string): readonly (readonly string[])[] {
    const messageIds = this.threads.get(threadId);
    if (messageIds === undefined) {
      throw new Error(`FakeGmail.threadLabels: unknown thread ${threadId}`);
    }
    return messageIds.map((id) => this.labelsOf(id));
  }

  // ---- Internals ----

  /** Records the call, then returns an injected failure, or `scope` while `gmail.modify` is revoked. */
  private begin<M extends GmailMethod>(
    method: M,
    args: readonly unknown[],
    threadId?: string,
  ): GmailFailureOf<M> | Fail<'scope', { message: string }> | undefined {
    this.onCall?.(method, args);
    this.calls.push({ method, args });
    this.unitsUsed += GMAIL_UNIT_COSTS[method];
    this.clock?.advance(this.latencyMs);
    const injected = this.failures.take(method, threadId);
    if (injected !== undefined) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- failNext accepts only GmailFailureOf<M> for method M, so an entry taken for M has that type
      return injected as GmailFailureOf<M>;
    }
    return this.scopes.failureFor(GMAIL_MODIFY_SCOPE);
  }

  private applyChange(
    threadId: string,
    addLabelIds: readonly string[],
    removeLabelIds: readonly string[],
  ): Result<NoFields, Fail<'not_found'> | Fail<'invalid_label', { message: string }>> {
    const messageIds = this.threads.get(threadId);
    if (messageIds === undefined) {
      return fail('not_found');
    }
    for (const labelId of [...addLabelIds, ...removeLabelIds]) {
      if (!this.labels.has(labelId)) {
        const message = /^Label_\d+$/.test(labelId)
          ? 'labelId not found'
          : `Invalid label: ${labelId}`;
        return fail('invalid_label', { message });
      }
    }
    const remove = new Set(removeLabelIds);
    if (addLabelIds.includes('SPAM') || addLabelIds.includes('TRASH')) {
      remove.add('INBOX');
    }
    const messages = messageIds.map((id) => this.message(id));
    for (const labelId of new Set(addLabelIds)) {
      const changed = messages.filter((m) => !m.labelIds.includes(labelId));
      if (changed.length > 0) {
        const historyId = this.nextHistoryId();
        for (const m of changed) {
          m.labelIds.push(labelId);
          m.historyId = historyId;
        }
        this.writeRecord(historyId, changed.map(ref), {
          labelsAdded: changed.map((m) => labelChange(m, labelId)),
        });
      }
    }
    for (const labelId of remove) {
      this.removeFromMessages(messages, labelId);
    }
    return ok({});
  }

  private removeFromMessages(messages: readonly StoredMessage[], labelId: string): void {
    const changed = messages.filter((m) => m.labelIds.includes(labelId));
    if (changed.length === 0) {
      return;
    }
    const historyId = this.nextHistoryId();
    for (const m of changed) {
      m.labelIds = m.labelIds.filter((l) => l !== labelId);
      m.historyId = historyId;
    }
    this.writeRecord(historyId, changed.map(ref), {
      labelsRemoved: changed.map((m) => labelChange(m, labelId)),
    });
  }

  private writeRecord(
    historyId: string,
    messages: readonly { id: string; threadId: string }[],
    change: Pick<GmailHistoryRecord, 'messagesAdded' | 'labelsAdded' | 'labelsRemoved'>,
  ): void {
    this.records.push({ id: historyId, messages: [...messages], ...change });
    if (this.bareRecords) {
      this.records.push({ id: this.nextHistoryId(), messages: [...messages] });
    }
  }

  private nextHistoryId(): string {
    this.currentHistoryId++;
    return String(this.currentHistoryId);
  }

  private addUserLabel(name: string): GmailLabel {
    const label: GmailLabel = { id: `Label_${String(this.nextLabelNumber++)}`, name, type: 'user' };
    this.labels.set(label.id, label);
    return label;
  }

  private message(id: string): StoredMessage {
    const message = this.messages.get(id);
    if (message === undefined) {
      throw new Error(`FakeGmail: unknown message ${id}`);
    }
    return message;
  }

  private toFull(m: StoredMessage): GmailMessage {
    return {
      ...toMinimal(m),
      historyId: m.historyId,
      ...(m.sizeEstimate === undefined ? {} : { sizeEstimate: m.sizeEstimate }),
      ...(m.snippet === undefined ? {} : { snippet: m.snippet }),
      ...(m.payload === undefined ? {} : { payload: clone(m.payload) }),
    };
  }

  private now(): number {
    return this.clock?.now() ?? 0;
  }
}

function toMinimal(m: StoredMessage): GmailMessage {
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: [...m.labelIds],
    internalDate: m.internalDate,
  };
}

function toMetadata(m: StoredMessage, names: readonly string[]): GmailMessage {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const headers = (m.payload?.headers ?? []).filter((h) => wanted.has(h.name.toLowerCase()));
  return {
    ...toMinimal(m),
    historyId: m.historyId,
    ...(m.snippet === undefined ? {} : { snippet: m.snippet }),
    payload: {
      ...(m.payload?.mimeType === undefined ? {} : { mimeType: m.payload.mimeType }),
      headers: headers.map((h) => ({ ...h })),
    },
  };
}

function ref(m: StoredMessage): { id: string; threadId: string } {
  return { id: m.id, threadId: m.threadId };
}

function labelChange(m: StoredMessage, labelId: string): GmailLabelChange {
  const message: GmailMessageRef = { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] };
  return { labelIds: [labelId], message };
}

/** Gmail's label-name comparison: case-insensitive, with spaces around `/` ignored (spike 25). */
function labelKey(name: string): string {
  return name.toLowerCase().replace(/\s*\/\s*/g, '/');
}

function encodeToken(kind: 'history', value: number): string {
  return Buffer.from(`${kind}:${String(value)}`).toString('base64url');
}

function decodeToken(kind: 'history', token: string): number {
  const [tokenKind, value] = Buffer.from(token, 'base64url').toString().split(':');
  const number = Number(value);
  if (tokenKind !== kind || !Number.isInteger(number)) {
    throw new Error(`FakeGmail: "${token}" isn't a ${kind} page token`);
  }
  return number;
}

function encodeSearchToken(generation: number, offset: number): string {
  return Buffer.from(`search:${String(generation)}:${String(offset)}`).toString('base64url');
}

/** The offset in a search token of the current generation, or `undefined` for any other string. */
function decodeSearchToken(token: string, generation: number): number | undefined {
  const [kind, tokenGeneration, value] = Buffer.from(token, 'base64url').toString().split(':');
  const offset = Number(value);
  if (
    kind !== 'search' ||
    tokenGeneration !== String(generation) ||
    value === undefined ||
    !Number.isInteger(offset)
  ) {
    return undefined;
  }
  return offset;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
