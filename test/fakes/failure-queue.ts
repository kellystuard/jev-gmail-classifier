/**
 * Failure injection shared by the Google-facing fakes: `failNext(method,
 * failure, options?)`. Injected failures are used first, in the order they
 * were added.
 */

export type FailNextOptions = {
  /** How many calls fail. Default 1. */
  readonly times?: number;
  /** Only calls for this thread fail. */
  readonly threadId?: string;
};

type Entry<M extends string, F> = {
  readonly method: M;
  readonly failure: F | Error;
  readonly threadId: string | undefined;
  remaining: number;
};

export class FailureQueue<M extends string, F> {
  private readonly entries: Entry<M, F>[] = [];

  add(method: M, failure: F | Error, options: FailNextOptions = {}): void {
    const times = options.times ?? 1;
    if (!Number.isInteger(times) || times < 1) {
      throw new Error(`failNext: times must be a positive integer, got ${String(times)}`);
    }
    this.entries.push({ method, failure, threadId: options.threadId, remaining: times });
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
