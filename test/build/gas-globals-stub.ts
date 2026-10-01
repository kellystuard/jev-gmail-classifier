/**
 * Minimal stand-ins for the Apps Script globals the real entry points touch,
 * for running the bundle in a `vm` context (`bundle.test.ts`). Only what
 * the six entry points call on an empty mailbox is here;
 * anything else throws, so an unexpected call fails the test loudly.
 *
 * Not a fake of a port: the app layer's tests use `test/fakes/`. This checks
 * the wiring and the adapters' use of the globals, through the bundle.
 */
import { DECLARED_SCOPES } from '../../src/core/declared-scopes.ts';

export type ConsoleLevel = 'info' | 'warn' | 'error';

export type ConsoleLine = {
  readonly level: ConsoleLevel;
  /** The line as written. */
  readonly text: string;
  /** The line parsed as JSON. */
  readonly json: Record<string, unknown>;
};

export type StubTrigger = { readonly handler: string; readonly minutes: number };

export type StubSearch = {
  readonly q?: string;
  readonly includeSpamTrash?: boolean;
  readonly maxResults?: number;
  readonly pageToken?: string;
};

export type GasGlobalsOptions = {
  /** Another execution holds the script lock: `tryLock` returns false. */
  readonly lockBusy?: boolean;
  /** Script Properties to start with. */
  readonly properties?: Readonly<Record<string, string>>;
  /** The mailbox's current `historyId`. */
  readonly historyId?: string;
};

export type GasGlobalsStub = {
  /** The globals, to pass to `vm.createContext`. */
  readonly globals: Record<string, unknown>;
  /** The Script Properties, live. */
  readonly properties: Map<string, string>;
  /** The project's time-driven triggers, live. */
  readonly triggers: StubTrigger[];
  /** Every `Threads.list` call's options, in order. */
  readonly searches: StubSearch[];
  /** Every `console.*` line, in order. */
  readonly lines: ConsoleLine[];
  /** The lines whose `event` is `event`. */
  events(event: string): ConsoleLine[];
  /** Whether the script lock is held now. */
  lockHeld(): boolean;
};

/** What `Utilities.getUuid()` returns: the log adapter's `runId`. */
export const STUB_UUID = '00000000-0000-4000-8000-000000000000';

function unexpected(name: string): never {
  throw new Error(`gas-globals-stub: ${name} is not stubbed`);
}

function parseLine(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`console line is not a JSON object: ${text}`);
  }
  return { ...parsed };
}

export function createGasGlobals(options: GasGlobalsOptions = {}): GasGlobalsStub {
  const properties = new Map(Object.entries(options.properties ?? {}));
  const triggers: StubTrigger[] = [];
  const lines: ConsoleLine[] = [];
  const searches: StubSearch[] = [];
  const historyId = options.historyId ?? '1000';
  let held = false;

  const write =
    (level: ConsoleLevel) =>
    (text: unknown): void => {
      if (typeof text !== 'string') throw new Error('console was given a non-string');
      lines.push({ level, text, json: parseLine(text) });
    };

  const scriptProperties = {
    getProperty: (key: string): string | null => properties.get(key) ?? null,
    setProperty: (key: string, value: string): void => {
      properties.set(key, value);
    },
    deleteProperty: (key: string): void => {
      properties.delete(key);
    },
    getKeys: (): string[] => [...properties.keys()],
    getProperties: (): Record<string, string> => Object.fromEntries(properties),
  };

  const toTrigger = (trigger: StubTrigger) => ({
    trigger,
    getHandlerFunction: () => trigger.handler,
    getUniqueId: () => `trigger-${trigger.handler}`,
  });

  const globals: Record<string, unknown> = {
    console: { info: write('info'), warn: write('warn'), error: write('error') },
    LockService: {
      getScriptLock: () => ({
        tryLock: (): boolean => {
          if (options.lockBusy === true) return false;
          held = true;
          return true;
        },
        hasLock: (): boolean => held,
        releaseLock: (): void => {
          held = false;
        },
      }),
    },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    Session: { getScriptTimeZone: () => 'Etc/UTC' },
    Utilities: {
      getUuid: () => STUB_UUID,
      sleep: (): void => undefined,
      newBlob: () => unexpected('Utilities.newBlob'),
    },
    ScriptApp: {
      AuthMode: { FULL: 'FULL' },
      getAuthorizationInfo: () => ({ getAuthorizedScopes: () => [...DECLARED_SCOPES] }),
      requireScopes: (): void => undefined,
      getProjectTriggers: () => triggers.map(toTrigger),
      deleteTrigger: (handle: { readonly trigger: StubTrigger }): void => {
        const at = triggers.indexOf(handle.trigger);
        if (at >= 0) triggers.splice(at, 1);
      },
      newTrigger: (handler: string) => ({
        timeBased: () => ({
          everyMinutes: (minutes: number) => ({
            create: () => {
              const trigger = { handler, minutes };
              triggers.push(trigger);
              return toTrigger(trigger);
            },
          }),
        }),
      }),
    },
    Gmail: {
      Users: {
        getProfile: () => ({ emailAddress: '<test-account>', historyId }),
        // An empty mailbox: no history records, at the current historyId.
        History: { list: () => ({ historyId }) },
        Labels: { list: () => ({ labels: [] }), create: () => unexpected('Labels.create') },
        Threads: {
          list: (_userId: string, search: StubSearch) => {
            searches.push(search);
            return {};
          },
          get: () => unexpected('Threads.get'),
          modify: () => unexpected('Threads.modify'),
        },
      },
    },
    UrlFetchApp: { fetchAll: () => unexpected('UrlFetchApp.fetchAll') },
  };

  return {
    globals,
    properties,
    triggers,
    searches,
    lines,
    events: (event) => lines.filter((line) => line.json['event'] === event),
    lockHeld: () => held,
  };
}
