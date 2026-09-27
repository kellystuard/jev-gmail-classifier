/**
 * The one script-wide lock, `LockService.getScriptLock()` (Solution Design
 * §5.2, §10.4). Owned by E7, which refines it.
 */
export interface LockPort {
  /** `tryLock(0)`: takes the lock without waiting. `false` if another execution holds it. */
  tryAcquire(): boolean;

  /** Releases the lock. Safe to call when it isn't held. */
  release(): void;
}
