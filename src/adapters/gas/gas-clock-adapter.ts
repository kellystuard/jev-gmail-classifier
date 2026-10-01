/**
 * `GasClockAdapter`: `ClockPort` over `Date.now()`, `Utilities.sleep` and
 * `Session.getScriptTimeZone()` (Solution Design §5.2, §10.3; epic #13
 * decision 13).
 *
 * Thin on purpose: no logic, so it is covered by `docs/smoke-test.md`, not by
 * unit tests (Engineering Standards §8). It doesn't log or cache: the time
 * zone is read on every call (`timeZone` in `appsscript.json`).
 */
import type { ClockPort } from '../../ports/clock-port.ts';

/**
 * There is no Apps Script type package (epic decision 15), and `declare const`
 * emits nothing: the globals are Apps Script's.
 */
declare const Utilities: { sleep(milliseconds: number): void };
declare const Session: { getScriptTimeZone(): string };

export class GasClockAdapter implements ClockPort {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): void {
    Utilities.sleep(ms);
  }

  timeZone(): string {
    return Session.getScriptTimeZone();
  }
}
