import type { LogFields } from '../../src/core/log-fields.ts';
import { isForbiddenLogField } from '../../src/core/redact.ts';
import type { LogPort } from '../../src/ports/log-port.ts';

export type LogLevel = 'info' | 'warn' | 'error';

export type LoggedEvent = {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: LogFields;
};

const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

function forbidden(event: string, name: string): Error {
  return new Error(`FakeLog: event "${event}" has a forbidden field "${name}"`);
}

/**
 * Records every event in order. Throws on a badly named event or a forbidden
 * field, so an app test catches a privacy slip early.
 */
export class FakeLog implements LogPort {
  readonly events: LoggedEvent[] = [];

  info(event: string, fields: LogFields = {}): void {
    this.record('info', event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.record('warn', event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.record('error', event, fields);
  }

  /** The first event with this name, or `undefined`. */
  find(event: string): LoggedEvent | undefined {
    return this.events.find((e) => e.event === event);
  }

  all(event: string): LoggedEvent[] {
    return this.events.filter((e) => e.event === event);
  }

  atLevel(level: LogLevel): LoggedEvent[] {
    return this.events.filter((e) => e.level === level);
  }

  private record(level: LogLevel, event: string, fields: LogFields): void {
    if (!EVENT_NAME.test(event)) {
      throw new Error(`FakeLog: "${event}" isn't a dotted lower-case event name`);
    }
    for (const [name, value] of Object.entries(fields)) {
      if (isForbiddenLogField(name)) throw forbidden(event, name);
      // A forbidden key in a record is allowed when its value is a number (a rule ID or label name).
      if (typeof value === 'object' && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          if (isForbiddenLogField(key) && typeof inner === 'string') throw forbidden(event, key);
        }
      }
    }
    this.events.push({ level, event, fields });
  }
}
