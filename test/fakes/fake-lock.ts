import type { LockPort } from '../../src/ports/lock-port.ts';

/**
 * The script lock. Another execution can hold it (`holdByOther`). Like
 * `LockService`, it's re-entrant for the execution that holds it, and
 * `release` is a no-op when not held.
 */
export class FakeLock implements LockPort {
  /** Successful `tryAcquire` calls. */
  acquireCount = 0;
  private holder: 'self' | 'other' | undefined = undefined;

  get isHeld(): boolean {
    return this.holder === 'self';
  }

  get isHeldByOther(): boolean {
    return this.holder === 'other';
  }

  tryAcquire(): boolean {
    if (this.holder === 'other') {
      return false;
    }
    this.holder = 'self';
    this.acquireCount++;
    return true;
  }

  release(): void {
    if (this.holder === 'self') {
      this.holder = undefined;
    }
  }

  /** Another execution takes the lock. Throws if this execution holds it. */
  holdByOther(): void {
    if (this.holder === 'self') {
      throw new Error('FakeLock.holdByOther: this execution holds the lock');
    }
    this.holder = 'other';
  }

  releaseByOther(): void {
    if (this.holder === 'other') {
      this.holder = undefined;
    }
  }
}
