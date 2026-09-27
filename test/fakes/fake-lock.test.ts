import { describe, expect, it } from 'vitest';

import { FakeLock } from './fake-lock.ts';

describe('FakeLock', () => {
  it('is acquired when free, and re-entrant for this execution', () => {
    const lock = new FakeLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isHeld).toBe(true);
    expect(lock.acquireCount).toBe(2);
  });

  it('returns false while another execution holds it', () => {
    const lock = new FakeLock();
    lock.holdByOther();
    expect(lock.tryAcquire()).toBe(false);
    expect(lock.isHeld).toBe(false);
    expect(lock.acquireCount).toBe(0);
    lock.releaseByOther();
    expect(lock.tryAcquire()).toBe(true);
  });

  it('treats release as a no-op when not held', () => {
    const lock = new FakeLock();
    lock.release();
    lock.holdByOther();
    lock.release();
    expect(lock.isHeldByOther).toBe(true);
  });

  it('releases the lock this execution holds', () => {
    const lock = new FakeLock();
    lock.tryAcquire();
    lock.release();
    expect(lock.isHeld).toBe(false);
    lock.holdByOther();
    expect(lock.isHeldByOther).toBe(true);
  });

  it('refuses holdByOther while this execution holds it', () => {
    const lock = new FakeLock();
    lock.tryAcquire();
    expect(() => {
      lock.holdByOther();
    }).toThrow(/holds the lock/);
  });
});
