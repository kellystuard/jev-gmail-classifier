/**
 * Failure injection shared by the Google-facing fakes: `failNext(method,
 * failure, options?)`. Injected failures are used first, in the order they
 * were added. Only the first matching entry applies to a call: while it is
 * still counting down its `after` calls, later entries for the same method
 * wait.
 */

export type FailNextOptions = {
  /** How many calls fail. Default 1. */
  readonly times?: number;
  /** Only calls for this thread fail. */
  readonly threadId?: string;
  /**
   * How many matching calls succeed before the failure applies. Default 0.
   * For example, `{ after: 2 }` lets two calls through and fails the third,
   * which lets a test stop a multi-step write part-way.
   */
  readonly after?: number;
};

type Entry<M extends string, F> = {
  readonly method: M;
  readonly failure: F | Error;
  readonly threadId: string | undefined;
  skip: number;
  remaining: number;
};

export class FailureQueue<M extends string, F> {
  private readonly entries: Entry<M, F>[] = [];

  add(method: M, failure: F | Error, options: FailNextOptions = {}): void {
    const times = options.times ?? 1;
    if (!Number.isInteger(times) || times < 1) {
      throw new Error(`failNext: times must be a positive integer, got ${String(times)}`);
    }
    const after = options.after ?? 0;
    if (!Number.isInteger(after) || after < 0) {
      throw new Error(`failNext: after must be a non-negative integer, got ${String(after)}`);
    }
    this.entries.push({
      method,
      failure,
      threadId: options.threadId,
      skip: after,
      remaining: times,
    });
  }

  /**
   * The next injected failure for this call, or `undefined`. An injected
   * `Error` is thrown.
   */
  take(method: M, threadId?: string): F | undefined {
    const index = this.entries.findIndex(
      (e) => e.method === method && (e.threadId === undefined || e.threadId === threadId),
    );
    const entry = this.entries[index];
    if (entry === undefined) {
      return undefined;
    }
    if (entry.skip > 0) {
      entry.skip--;
      return undefined;
    }
    entry.remaining--;
    if (entry.remaining === 0) {
      this.entries.splice(index, 1);
    }
    if (entry.failure instanceof Error) {
      throw entry.failure;
    }
    return entry.failure;
  }

  /** How many injected failures are still waiting. */
  get pending(): number {
    return this.entries.reduce((sum, e) => sum + e.remaining, 0);
  }
}

/** One recorded call to a fake. */
export type FakeCall<M extends string = string> = {
  readonly method: M;
  readonly args: readonly unknown[];
};
