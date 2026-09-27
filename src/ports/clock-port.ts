/**
 * Time: `Date`, `Utilities.sleep` and `Session.getScriptTimeZone()` (Solution
 * Design §5.2, §10.3). `sleep` is the only way to wait: `setTimeout` is
 * banned (Engineering Standards §4).
 */
export interface ClockPort {
  /** The current time, in epoch milliseconds. */
  now(): number;

  /** Blocks for `ms` milliseconds. */
  sleep(ms: number): void;

  /** The script's IANA time zone (`timeZone` in `appsscript.json`), for example `Etc/UTC`. */
  timeZone(): string;
}
