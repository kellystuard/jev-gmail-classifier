/**
 * The exception hierarchy (Solution Design §10.1, §11; ADR-0006).
 *
 * Exceptions are for invalid input or invalid state. Expected failures are
 * results (`./result.ts`). Every class sets `name` explicitly, because bundling
 * can rename classes, and assigns its properties in the constructor body: no
 * class field initializers, `#private` or static fields (Engineering
 * Standards §4).
 */
import type { LogFields, LogValue } from './log-fields.ts';

export interface JevClassifierErrorOptions {
  /** The error that caused this one. `toLogFields()` logs its name and message. */
  readonly cause?: unknown;
}

/**
 * The base of every exception the classifier throws on purpose. It carries
 * structured, JSON-safe fields for the log.
 *
 * **Never** put a message body, a Jev request's `state`, the API key or the
 * `Authorization` header in the message, the fields, or the cause (Engineering
 * Standards §6). Subjects, senders and IDs are allowed.
 */
export class JevClassifierError extends Error {
  declare readonly fields: LogFields;
  declare readonly cause: unknown;

  constructor(message: string, fields: LogFields = {}, options?: JevClassifierErrorOptions) {
    super(message);
    this.name = 'JevClassifierError';
    this.fields = fields;
    this.cause = options?.cause;
  }

  /**
   * Flat, JSON-safe fields for the log: the error's `fields`, then `error`
   * (the class name), `errorMessage` and, when there is a cause, `cause`
   * (`"<name>: <message>"`). Those three keys are reserved: they're written
   * last, so a field with the same name can't hide them. No stack: the log
   * adapter decides about stacks.
   */
  toLogFields(): LogFields {
    const out: Record<string, LogValue> = {
      ...this.fields,
      error: this.name,
      errorMessage: this.message,
    };
    if (this.cause !== undefined) {
      out['cause'] = describeCause(this.cause);
    }
    return out;
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  return String(cause);
}

/** One config validation issue. `path` is dotted with indexes, like `rules[2].threshold`. */
export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * The config failed validation at build time or at runtime load, or a state
 * migration can't run because of the config. `config/` converts schema issues
 * to `ConfigIssue`s, so `core/` has no validation-library dependency and
 * `config/` can import this class without a cycle.
 */
export class ConfigError extends JevClassifierError {
  declare readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[], options?: JevClassifierErrorOptions) {
    const lines = issues.map(formatConfigIssue);
    super(['Invalid config:', ...lines].join('\n'), { issues: lines }, options);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Formats an issue as `<path>: <message>`. An empty path is the config's root. */
export function formatConfigIssue(issue: ConfigIssue): string {
  return `${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`;
}

export type StateErrorReason = 'parse' | 'version' | 'schema' | 'too_large' | 'store_full' | 'bad_key';

export type StateErrorDetails = {
  readonly key: string;
  readonly reason: StateErrorReason;
  readonly bytes?: number;
  readonly limit?: number;
  readonly version?: number;
};

/**
 * A stored `state.*` value is invalid (bad JSON, an unknown `v`, a failed
 * schema check, a migration that can't run), or a write goes over the Script
 * Properties limits.
 */
export class StateError extends JevClassifierError {
  declare readonly key: string;
  declare readonly reason: StateErrorReason;
  declare readonly bytes: number | undefined;
  declare readonly limit: number | undefined;
  declare readonly version: number | undefined;

  constructor(message: string, details: StateErrorDetails, options?: JevClassifierErrorOptions) {
    super(message, withoutUndefined(details), options);
    this.name = 'StateError';
    this.key = details.key;
    this.reason = details.reason;
    this.bytes = details.bytes;
    this.limit = details.limit;
    this.version = details.version;
  }
}

export type ResponseService = 'jev' | 'gmail' | 'mail' | 'trigger' | 'auth';

export type UnexpectedResponseDetails = {
  readonly service: ResponseService;
  readonly status?: number;
  readonly requestId?: string;
  /** A short description. Never a response body. */
  readonly reason: string;
};

/**
 * A response no rule expects: a malformed 200, a missing answer, a generic
 * 500, an unrecognized Gmail error.
 */
export class UnexpectedResponseError extends JevClassifierError {
  declare readonly service: ResponseService;
  declare readonly status: number | undefined;
  declare readonly requestId: string | undefined;
  declare readonly reason: string;

  constructor(
    message: string,
    details: UnexpectedResponseDetails,
    options?: JevClassifierErrorOptions,
  ) {
    super(message, withoutUndefined(details), options);
    this.name = 'UnexpectedResponseError';
    this.service = details.service;
    this.status = details.status;
    this.requestId = details.requestId;
    this.reason = details.reason;
  }
}

/** A failed result, minus `ok`, flattened into log fields. */
export type ThreadFailure = { readonly kind: string } & LogFields;

export interface ThreadProcessingDetails {
  readonly threadId: string;
  readonly failure: ThreadFailure;
}

/**
 * Thrown on purpose to carry a failed result to the per-thread boundary
 * (Engineering Standards §5). The log fields are the failure's fields
 * (including `kind`) plus `threadId`. An `ok` key in the failure is dropped.
 */
export class ThreadProcessingError extends JevClassifierError {
  declare readonly threadId: string;
  declare readonly failure: ThreadFailure;

  constructor(message: string, details: ThreadProcessingDetails, options?: JevClassifierErrorOptions) {
    const fields: Record<string, LogValue> = {};
    for (const [key, value] of Object.entries(details.failure)) {
      if (key !== 'ok') {
        fields[key] = value;
      }
    }
    fields['threadId'] = details.threadId;
    super(message, fields, options);
    this.name = 'ThreadProcessingError';
    this.threadId = details.threadId;
    this.failure = details.failure;
  }
}

export type RunAbortReason = 'auth' | 'missing_key' | 'config_invalid';

export type RunAbortDetails = {
  readonly reason: RunAbortReason;
};

/**
 * The run must stop without marking anything: a 401, a missing key, or an
 * invalid config at load. Only the per-run boundary catches it.
 */
export class RunAbortError extends JevClassifierError {
  declare readonly reason: RunAbortReason;

  constructor(message: string, details: RunAbortDetails, options?: JevClassifierErrorOptions) {
    super(message, { reason: details.reason }, options);
    this.name = 'RunAbortError';
    this.reason = details.reason;
  }
}

/** Copies the defined properties of a flat details object into log fields. */
function withoutUndefined(details: Readonly<Record<string, LogValue | undefined>>): LogFields {
  const out: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
