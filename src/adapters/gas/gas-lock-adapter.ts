/**
 * `GasLockAdapter`: `LockPort` over the one script-wide lock,
 * `LockService.getScriptLock()` (Solution Design §5.2, §10.4; ADR-0008; epic
 * #13 decision 14).
 *
 * The adapter gets one `Lock` object on the first `tryAcquire()` and keeps it,
 * so `release()` uses the same object. `tryAcquire()` is `tryLock(0)`: it never
 * waits. `LockService` is re-entrant for the holder, so a second call in the
 * same execution returns `true`, as `FakeLock` does.
 *
 * Failure classification (Engineering Standards §5): a lock another execution
 * holds is a normal `false`. Anything `LockService` throws is exceptional and
 * is not caught here: it reaches the per-run boundary (SD §10.1). The adapter
 * doesn't log; `run.skipped` is logged by `runEntry`.
 *
 * Apps Script frees the script lock when the execution ends, so a crashed run
 * never leaves it held (smoke check 5 in `docs/smoke-test.md`). `LockService`
 * is not behind any declared scope (spike 27, P9).
 */
import type { LockPort } from '../../ports/lock-port.ts';

/** The methods of Apps Script's `Lock` this file uses. */
interface ScriptLock {
  tryLock(timeoutInMillis: number): boolean;
  hasLock(): boolean;
  releaseLock(): void;
}

/**
 * There is no Apps Script type package (epic decision 15), and `declare const`
 * emits nothing: the global is Apps Script's.
 */
declare const LockService: { getScriptLock(): ScriptLock };

export class GasLockAdapter implements LockPort {
  private lock: ScriptLock | undefined;

  tryAcquire(): boolean {
    this.lock ??= LockService.getScriptLock();
    return this.lock.tryLock(0);
  }

  release(): void {
    if (this.lock?.hasLock() === true) {
      this.lock.releaseLock();
    }
  }
}
