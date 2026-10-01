/**
 * `GasLogAdapter`: `LogPort` over `console.info` / `console.warn` /
 * `console.error` (Solution Design §5.2, §10.5; Engineering Standards §6;
 * ADR-0014; epic #13 decision 13). The only file in `src/` that may use
 * `console` (`scripts/lint/layers.ts`).
 *
 * Each call writes **one** line of JSON:
 * `{event, runId, entry, ts, ...fields}`. The four reserved keys come first,
 * and a field with the same name can't change them. `runId` is one
 * `Utilities.getUuid()` per instance, and the composition root builds one
 * instance per execution, so it identifies the execution. `ts` is the ISO
 * time of the call. If `JSON.stringify` throws, the line is the four keys and
 * `logError: 'unserializable'`.
 *
 * Every event's fields go through `redact` (`src/core/redact.ts`, where the
 * rules are): forbidden names, `Bearer <token>`, the `secretValues` and
 * over-long strings are scrubbed. The reserved keys aren't. Callers still never
 * pass a body, the key, the header or a `state` (the `LogPort` contract);
 * `redact` is the backstop. A log call never throws.
 */
import type { LogFields } from '../../core/log-fields.ts';
import { redact } from '../../core/redact.ts';
import type { LogPort } from '../../ports/log-port.ts';

/**
 * There is no Apps Script type package (epic decision 15), and `declare const`
 * emits nothing: the global is Apps Script's.
 */
declare const Utilities: { getUuid(): string };

export type GasLogAdapterOptions = {
  /** The entry point this execution runs, such as `onTrigger`. */
  readonly entry: string;
  /** Values to scrub from every string, such as the Jev key. Called at most once per instance, at the first event. */
  readonly secretValues?: () => readonly string[];
};

type Level = 'info' | 'warn' | 'error';

export class GasLogAdapter implements LogPort {
  private readonly entry: string;
  private readonly runId: string;
  private readonly secretValues: (() => readonly string[]) | undefined;
  private secrets: readonly string[] = [];
  private secretsResolved = false;

  constructor(options: GasLogAdapterOptions) {
    this.entry = options.entry;
    this.runId = Utilities.getUuid();
    this.secretValues = options.secretValues;
  }

  info(event: string, fields?: LogFields): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.write('error', event, fields);
  }

  private write(level: Level, event: string, fields: LogFields = {}): void {
    const reserved = { event, runId: this.runId, entry: this.entry, ts: new Date().toISOString() };
    let line: string;
    try {
      // Reserved keys first in the line, and again last so a field can't override them.
      line = JSON.stringify({ ...reserved, ...redact(fields, this.resolveSecrets()), ...reserved });
    } catch {
      line = JSON.stringify({ ...reserved, logError: 'unserializable' });
    }
    console[level](line);
  }

  /** The secrets, read once at the first event. A throw or a non-array means none. */
  private resolveSecrets(): readonly string[] {
    if (this.secretsResolved) return this.secrets;
    this.secretsResolved = true;
    try {
      const values: unknown = this.secretValues?.();
      if (Array.isArray(values)) {
        this.secrets = values.filter((v: unknown): v is string => typeof v === 'string');
      }
    } catch {
      this.secrets = [];
    }
    return this.secrets;
  }
}
