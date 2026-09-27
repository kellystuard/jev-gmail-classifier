import { type Fail, type NoFields, type Result, ok } from '../../src/core/result.ts';
import type { TriggerIntervalMinutes, TriggerPort } from '../../src/ports/trigger-port.ts';
import { FakeScopes } from './fake-scopes.ts';
import { type FailNextOptions, type FakeCall, FailureQueue } from './failure-queue.ts';

type TriggerMethod = 'replaceRecurringTrigger' | 'deleteTriggers';
type ScopeFailure = Fail<'scope', { message: string }>;

export type FakeTriggerEntry = {
  readonly handler: string;
  readonly minutes: TriggerIntervalMinutes;
};

const ALLOWED_MINUTES: readonly number[] = [1, 5, 10, 15, 30];
const SCRIPTAPP_SCOPE = 'https://www.googleapis.com/auth/script.scriptapp';

/** `ScriptApp` time-driven triggers. Needs `script.scriptapp`. */
export class FakeTrigger implements TriggerPort {
  readonly calls: FakeCall<TriggerMethod>[] = [];
  private entries: FakeTriggerEntry[] = [];
  private readonly scopes: FakeScopes;
  private readonly failures = new FailureQueue<TriggerMethod, ScopeFailure>();

  constructor(options: { readonly scopes?: FakeScopes } = {}) {
    this.scopes = options.scopes ?? new FakeScopes();
  }

  /** The current triggers. */
  get triggers(): readonly FakeTriggerEntry[] {
    return [...this.entries];
  }

  replaceRecurringTrigger(
    handler: string,
    minutes: TriggerIntervalMinutes,
  ): Result<NoFields, ScopeFailure> {
    this.calls.push({ method: 'replaceRecurringTrigger', args: [handler, minutes] });
    if (!ALLOWED_MINUTES.includes(minutes)) {
      throw new Error(
        `FakeTrigger: ${String(minutes)} isn't an allowed interval (1, 5, 10, 15 or 30)`,
      );
    }
    const failure = this.failure('replaceRecurringTrigger');
    if (failure !== undefined) {
      return failure;
    }
    this.entries = this.entries.filter((t) => t.handler !== handler);
    this.entries.push({ handler, minutes });
    return ok({});
  }

  deleteTriggers(handler: string): Result<{ deleted: number }, ScopeFailure> {
    this.calls.push({ method: 'deleteTriggers', args: [handler] });
    const failure = this.failure('deleteTriggers');
    if (failure !== undefined) {
      return failure;
    }
    const before = this.entries.length;
    this.entries = this.entries.filter((t) => t.handler !== handler);
    return ok({ deleted: before - this.entries.length });
  }

  /** Adds a trigger directly, for example a duplicate left by an old install. */
  seed(entry: FakeTriggerEntry): void {
    this.entries.push(entry);
  }

  failNext(
    method: TriggerMethod,
    failure: ScopeFailure | Error,
    options: FailNextOptions = {},
  ): void {
    this.failures.add(method, failure, options);
  }

  private failure(method: TriggerMethod): ScopeFailure | undefined {
    return this.failures.take(method) ?? this.scopes.failureFor(SCRIPTAPP_SCOPE);
  }
}
