import type { DeclaredScope } from '../../src/core/declared-scopes.ts';
import { FakeAuth } from './fake-auth.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeGmail, type FakeGmailOptions } from './fake-gmail.ts';
import { FakeHttp } from './fake-http.ts';
import { FakeLock } from './fake-lock.ts';
import { FakeLog } from './fake-log.ts';
import { FakeMail } from './fake-mail.ts';
import { FakeRandom } from './fake-random.ts';
import { FakeScopes } from './fake-scopes.ts';
import { FakeSecrets } from './fake-secrets.ts';
import { FakeState } from './fake-state.ts';
import { FakeTrigger } from './fake-trigger.ts';

export type FakePortsOptions = {
  /** Default `2026-09-26T12:00:00Z`. */
  readonly now?: number | string;
  /** Default `Etc/UTC`. */
  readonly timeZone?: string;
  /** Default every declared scope. */
  readonly grantedScopes?: readonly DeclaredScope[];
  /** Default `test-key`. Pass `undefined` explicitly for no key. */
  readonly jevApiKey?: string | undefined;
  readonly seed?: number;
  readonly gmailLatencyMs?: number;
  readonly httpLatencyMs?: number;
  readonly mailDailyQuota?: number;
  readonly gmail?: Pick<
    FakeGmailOptions,
    'emailAddress' | 'historyId' | 'bareRecords' | 'pageSize' | 'maxSearchPageSize'
  >;
};

export type FakePorts = {
  readonly clock: FakeClock;
  readonly scopes: FakeScopes;
  readonly gmail: FakeGmail;
  readonly http: FakeHttp;
  readonly state: FakeState;
  readonly secrets: FakeSecrets;
  readonly lock: FakeLock;
  readonly random: FakeRandom;
  readonly log: FakeLog;
  readonly mail: FakeMail;
  readonly trigger: FakeTrigger;
  readonly auth: FakeAuth;
};

/** Every fake, wired to one clock and one set of scopes: a consistent world in one line. */
export function createFakePorts(options: FakePortsOptions = {}): FakePorts {
  const clock = new FakeClock({
    now: options.now ?? '2026-09-26T12:00:00Z',
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const scopes = new FakeScopes(options.grantedScopes);
  const jevApiKey = 'jevApiKey' in options ? options.jevApiKey : 'test-key';
  return {
    clock,
    scopes,
    gmail: new FakeGmail({
      ...options.gmail,
      scopes,
      clock,
      latencyMs: options.gmailLatencyMs ?? 0,
    }),
    http: new FakeHttp({ scopes, clock, latencyMs: options.httpLatencyMs ?? 0 }),
    state: new FakeState(),
    secrets: new FakeSecrets(jevApiKey === undefined ? {} : { jevApiKey }),
    lock: new FakeLock(),
    random: new FakeRandom(options.seed),
    log: new FakeLog(),
    mail: new FakeMail({
      scopes,
      ...(options.mailDailyQuota === undefined ? {} : { dailyQuota: options.mailDailyQuota }),
    }),
    trigger: new FakeTrigger({ scopes }),
    auth: new FakeAuth({ scopes }),
  };
}
